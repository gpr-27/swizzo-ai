// Log a fake user in through the app's real session sealing.
import { saveSession } from "@/backend/config/session";
import { jar } from "./fakeHeaders";

export const TEST_TOKEN = "test-access-token-not-a-real-swiggy-token";

export async function logIn(token = TEST_TOKEN): Promise<void> {
  await saveSession({ accessToken: token, expiresAt: Date.now() + 3_600_000 });
}

export function logOut(): void {
  jar.clear();
}
