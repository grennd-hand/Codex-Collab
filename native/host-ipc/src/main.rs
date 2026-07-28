use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use codex_collab_host_ipc::auth::{Capabilities, now_millis, random_instance_id};
use codex_collab_host_ipc::frame::{read_frame, write_frame};
use codex_collab_host_ipc::instance::{EXIT_HOST_ALREADY_RUNNING, UserHostMutex};
use codex_collab_host_ipc::pipe::{PipeHandle, wake_server};
use codex_collab_host_ipc::protocol::{
    AuthenticatedPeer, AuthenticationReady, BrokerBootstrap, BrokerReady, ClientRequest,
    ServerChallenge, parse_client_hello, parse_client_proof, route_parent_frame,
};
use codex_collab_host_ipc::security::PipeSecurity;
use codex_collab_host_ipc::{
    AUTH_TIMEOUT_MILLIS, MAX_FRAME_BYTES, MAX_HANDSHAKE_FRAME_BYTES, PROTOCOL_VERSION,
};
use zeroize::Zeroize;

const PARENT_QUEUE_CAPACITY: usize = 64;
const CONNECTION_QUEUE_CAPACITY: usize = 1;
const MAX_ACTIVE_CONNECTIONS: usize = 8;

#[derive(Clone)]
struct ConnectionRoute {
    sender: SyncSender<Vec<u8>>,
    pipe: Arc<PipeHandle>,
}

type Routes = Arc<Mutex<HashMap<u64, ConnectionRoute>>>;

fn main() {
    if let Err(error) = run() {
        eprintln!("[codex-collab-host-ipc] {error}");
        let exit_code = if error.kind() == io::ErrorKind::AlreadyExists {
            EXIT_HOST_ALREADY_RUNNING
        } else {
            1
        };
        std::process::exit(exit_code);
    }
}

fn run() -> io::Result<()> {
    // This fixed per-user object is the authoritative single-instance gate.
    // It must be acquired before reading bootstrap or constructing Host state.
    let security = Arc::new(PipeSecurity::for_current_user()?);
    let _instance_mutex = UserHostMutex::acquire(&security)?;
    let stdin = io::stdin();
    let bootstrap = {
        let mut stdin_lock = stdin.lock();
        read_frame(&mut stdin_lock, MAX_HANDSHAKE_FRAME_BYTES)?.ok_or_else(|| {
            io::Error::new(io::ErrorKind::UnexpectedEof, "missing broker bootstrap")
        })?
    };
    BrokerBootstrap::parse(&bootstrap)?;

    let instance_id = random_instance_id()?;
    let pipe_path = format!(r"\\.\pipe\codex-collab-host-{instance_id}");
    let capabilities = Arc::new(Capabilities::generate()?);
    let mut next_pipe = Some(Arc::new(PipeHandle::create(&pipe_path, &security, true)?));

    let mut ready = BrokerReady {
        v: PROTOCOL_VERSION,
        frame_type: "broker.ready",
        instance_id: &instance_id,
        pipe_path: &pipe_path,
        pid: std::process::id(),
        capabilities: capabilities.ready_capabilities(),
    };
    let mut ready_payload = serde_json::to_vec(&ready).map_err(json_error)?;
    {
        let mut stdout = io::stdout().lock();
        write_frame(&mut stdout, &ready_payload, MAX_HANDSHAKE_FRAME_BYTES)?;
    }
    for capability in &mut ready.capabilities {
        capability.secret.zeroize();
    }
    ready_payload.zeroize();

    let shutdown = Arc::new(AtomicBool::new(false));
    let routes: Routes = Arc::new(Mutex::new(HashMap::new()));
    let active_connections = Arc::new(AtomicUsize::new(0));
    let next_connection_id = Arc::new(AtomicU64::new(1));
    let (parent_sender, parent_receiver) = mpsc::sync_channel(PARENT_QUEUE_CAPACITY);

    spawn_stdout_writer(
        parent_receiver,
        Arc::clone(&shutdown),
        Arc::clone(&routes),
        pipe_path.clone(),
    );
    spawn_parent_dispatcher(
        stdin,
        Arc::clone(&shutdown),
        Arc::clone(&routes),
        pipe_path.clone(),
    );

    while !shutdown.load(Ordering::Acquire) {
        let pipe = next_pipe
            .take()
            .ok_or_else(|| io::Error::other("missing named-pipe listener"))?;
        pipe.connect()?;
        if shutdown.load(Ordering::Acquire) {
            pipe.disconnect();
            break;
        }

        let active_before = active_connections.fetch_add(1, Ordering::AcqRel);
        if active_before >= MAX_ACTIVE_CONNECTIONS {
            active_connections.fetch_sub(1, Ordering::AcqRel);
            pipe.disconnect();
        } else {
            let connection_id = next_connection_id.fetch_add(1, Ordering::Relaxed);
            let connection_routes = Arc::clone(&routes);
            let connection_capabilities = Arc::clone(&capabilities);
            let connection_security = Arc::clone(&security);
            let connection_sender = parent_sender.clone();
            let connection_active = Arc::clone(&active_connections);
            thread::spawn(move || {
                let _active_guard = ActiveConnectionGuard(connection_active);
                if let Err(error) = handle_connection(
                    connection_id,
                    pipe,
                    connection_security,
                    connection_capabilities,
                    connection_routes,
                    connection_sender,
                ) {
                    if !matches!(
                        error.kind(),
                        io::ErrorKind::BrokenPipe | io::ErrorKind::UnexpectedEof
                    ) {
                        eprintln!("[codex-collab-host-ipc] connection closed: {error}");
                    }
                }
            });
        }

        if !shutdown.load(Ordering::Acquire) {
            next_pipe = Some(Arc::new(PipeHandle::create(&pipe_path, &security, false)?));
        }
    }

    request_shutdown(&shutdown, &routes, &pipe_path);
    let drain_deadline = Instant::now() + Duration::from_secs(2);
    while active_connections.load(Ordering::Acquire) != 0 && Instant::now() < drain_deadline {
        thread::sleep(Duration::from_millis(10));
    }
    drop(parent_sender);
    Ok(())
}

struct ActiveConnectionGuard(Arc<AtomicUsize>);

impl Drop for ActiveConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn handle_connection(
    connection_id: u64,
    pipe: Arc<PipeHandle>,
    security: Arc<PipeSecurity>,
    capabilities: Arc<Capabilities>,
    routes: Routes,
    parent_sender: SyncSender<Vec<u8>>,
) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_millis(AUTH_TIMEOUT_MILLIS);
    let hello_payload = pipe.read_frame_until(deadline, MAX_HANDSHAKE_FRAME_BYTES)?;
    security.validate_named_pipe_client(pipe.raw())?;
    let hello = parse_client_hello(&hello_payload)?;
    let pending = capabilities.begin(hello, now_millis()?)?;
    let client_nonce = pending.client_nonce_encoded();
    let server_nonce = pending.server_nonce_encoded();
    let challenge = ServerChallenge {
        v: PROTOCOL_VERSION,
        frame_type: "auth.challenge",
        client_kind: pending.client_kind,
        key_id: &pending.key_id,
        client_nonce: &client_nonce,
        server_nonce: &server_nonce,
        expires_at: pending.expires_at,
        server_proof: &pending.server_proof,
    };
    pipe.write_frame(
        &serde_json::to_vec(&challenge).map_err(json_error)?,
        MAX_HANDSHAKE_FRAME_BYTES,
    )?;
    let proof_payload = pipe.read_frame_until(deadline, MAX_HANDSHAKE_FRAME_BYTES)?;
    let peer = capabilities.finish(&pending, parse_client_proof(&proof_payload)?, now_millis()?)?;
    let ready = AuthenticationReady {
        v: PROTOCOL_VERSION,
        frame_type: "auth.ready",
        session_id: &peer.session_id,
    };
    pipe.write_frame(
        &serde_json::to_vec(&ready).map_err(json_error)?,
        MAX_HANDSHAKE_FRAME_BYTES,
    )?;

    let (client_sender, client_receiver) = mpsc::sync_channel(CONNECTION_QUEUE_CAPACITY);
    routes
        .lock()
        .map_err(|_| io::Error::other("connection routing table was poisoned"))?
        .insert(
            connection_id,
            ConnectionRoute {
                sender: client_sender,
                pipe: Arc::clone(&pipe),
            },
        );
    let read_result =
        proxy_client_requests(connection_id, &pipe, &peer, parent_sender, client_receiver);
    routes
        .lock()
        .map_err(|_| io::Error::other("connection routing table was poisoned"))?
        .remove(&connection_id);
    pipe.disconnect();
    read_result
}

fn proxy_client_requests(
    connection_id: u64,
    pipe: &PipeHandle,
    peer: &AuthenticatedPeer,
    parent_sender: SyncSender<Vec<u8>>,
    client_receiver: mpsc::Receiver<Vec<u8>>,
) -> io::Result<()> {
    loop {
        let payload = pipe.read_frame(MAX_FRAME_BYTES)?;
        let request = ClientRequest::parse(&payload, peer.client_kind)?;
        let parent_frame = request.into_parent_frame(connection_id, peer)?;
        parent_sender
            .send(parent_frame)
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "Host parent disconnected"))?;
        let response = client_receiver
            .recv()
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "Host parent disconnected"))?;
        pipe.write_frame(&response, MAX_FRAME_BYTES)?;
    }
}

fn spawn_stdout_writer(
    receiver: mpsc::Receiver<Vec<u8>>,
    shutdown: Arc<AtomicBool>,
    routes: Routes,
    pipe_path: String,
) {
    thread::spawn(move || {
        let mut stdout = io::stdout().lock();
        while let Ok(payload) = receiver.recv() {
            if let Err(error) = write_frame(&mut stdout, &payload, MAX_FRAME_BYTES) {
                eprintln!("[codex-collab-host-ipc] parent output failed: {error}");
                request_shutdown(&shutdown, &routes, &pipe_path);
                break;
            }
        }
    });
}

fn spawn_parent_dispatcher(
    stdin: io::Stdin,
    shutdown: Arc<AtomicBool>,
    routes: Routes,
    pipe_path: String,
) {
    thread::spawn(move || {
        let mut stdin = stdin.lock();
        loop {
            let payload = match read_frame(&mut stdin, MAX_FRAME_BYTES) {
                Ok(Some(payload)) => payload,
                Ok(None) => break,
                Err(error) => {
                    eprintln!("[codex-collab-host-ipc] parent input failed: {error}");
                    break;
                }
            };
            let routed = match route_parent_frame(&payload) {
                Ok(routed) => routed,
                Err(error) => {
                    eprintln!("[codex-collab-host-ipc] rejected parent frame: {error}");
                    break;
                }
            };
            let route = routes
                .lock()
                .ok()
                .and_then(|entries| entries.get(&routed.connection_id).cloned());
            let Some(route) = route else {
                continue;
            };
            match route.sender.try_send(routed.payload) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                    route.pipe.disconnect();
                    if let Ok(mut entries) = routes.lock() {
                        entries.remove(&routed.connection_id);
                    }
                }
            }
        }
        request_shutdown(&shutdown, &routes, &pipe_path);
    });
}

fn request_shutdown(shutdown: &AtomicBool, routes: &Routes, pipe_path: &str) {
    if shutdown.swap(true, Ordering::AcqRel) {
        return;
    }
    let pipes = if let Ok(mut entries) = routes.lock() {
        let pipes = entries
            .values()
            .map(|route| Arc::clone(&route.pipe))
            .collect::<Vec<_>>();
        entries.clear();
        pipes
    } else {
        Vec::new()
    };
    for pipe in pipes {
        pipe.disconnect();
    }
    wake_server(pipe_path);
}

fn json_error(error: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}
