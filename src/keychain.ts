import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readLoginKeychainPassword(service: string, account: string): Promise<string> {
  if (!service || !account) throw new Error("keychain-item-invalid");
  const keychain = join(homedir(), "Library", "Keychains", "login.keychain-db");
  const { stdout } = await execFileAsync("/usr/bin/security",
    ["find-generic-password", "-s", service, "-a", account, "-w", keychain],
    { encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 });
  const password = stdout.replace(/\r?\n$/, "");
  if (!password || password.includes("\n")) throw new Error("keychain-secret-invalid");
  return password;
}
