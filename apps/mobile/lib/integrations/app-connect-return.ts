import { bestEffort } from "@rakazo/logging/best-effort";
import { rpc } from "../api/api";

/**
 * Finishes a catalog sign-in the in-app browser handed back to the app. The card that started it
 * reads the connection itself while it is on screen; this lands it when that card is gone, and
 * the server then updates the card and lets the bot carry on.
 */
export function finishReturnedAppConnection(link: string) {
  const query = link.split("?")[1];
  const connectionId = query ? new URLSearchParams(query).get("connection") : null;
  if (!connectionId) return;
  void bestEffort("finish a returned app sign-in", rpc("connections/complete", { connectionId }));
}
