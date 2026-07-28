import {
  flipFuses,
  FuseV1Options,
  FuseVersion,
} from "@electron/fuses";
import { join } from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const executable = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
}
