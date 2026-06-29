/**
 * The HTTP/API channel the A/B harness (src/ab-eval.ts) drives.
 *
 * eve's HTTP channel fails closed in production: traffic is rejected unless an
 * authenticator accepts it. `localDev()` admits loopback `npx eve dev` traffic (the
 * default Phase-1 path); `vercelOidc()` admits a deployed agent's own platform calls.
 *
 * To drive a DEPLOYED agent from this harness, add an `httpBasic(...)` or
 * `jwtHmac(...)` authenticator here and send the matching credential from the
 * harness (see EVE_AUTH_TOKEN in .env.example).
 */
import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";

export default eveChannel({
  auth: [vercelOidc(), localDev()],
});
