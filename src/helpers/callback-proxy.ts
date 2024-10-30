import { issueCommentCreatedCallback } from "../handlers/comment-created-callback";
import { Context, SupportedEventsU } from "../types";
import { ProxyCallbacks } from "../types/proxy";
import { bubbleUpErrorComment } from "./errors";

/**
 * The `callbacks` object defines an array of callback functions for each supported event type.
 *
 * Since multiple callbacks might need to be executed for a single event, we store each
 * callback in an array. This design allows for extensibility and flexibility, enabling
 * us to add more callbacks for a particular event without modifying the core logic.
 */
const callbacks = {
  "issue_comment.created": [issueCommentCreatedCallback],
} as ProxyCallbacks;

/**
 * The `proxyCallbacks` function returns a Proxy object that intercepts access to the
 * `callbacks` object. This Proxy enables dynamic handling of event callbacks, including:
 *
 * - **Event Handling:** When an event occurs, the Proxy looks up the corresponding
 *   callbacks in the `callbacks` object. If no callbacks are found for the event,
 *   it returns a `skipped` status.
 *
 * - **Error Handling:** If an error occurs while processing a callback, the Proxy
 *   logs the error and returns a `failed` status.
 *
 * The Proxy uses the `get` trap to intercept attempts to access properties on the
 * `callbacks` object. This trap allows us to asynchronously execute the appropriate
 * callbacks based on the event type, ensuring that the correct context is passed to
 * each callback.
 */
export function proxyCallbacks(context: Context): ProxyCallbacks {
  return new Proxy(callbacks, {
    get(target, prop: SupportedEventsU) {
      if (!target[prop]) {
        context.logger.info(`No callbacks found for event ${prop}`);
        return { status: 204, reason: "skipped" };
      }
      return (async () => {
        try {
          return await Promise.all(target[prop].map((callback) => handleCallback(callback, context)));
        } catch (er) {
          return { status: 500, reason: (await bubbleUpErrorComment(context, er)).logMessage.raw };
        }
      })();
    },
  });
}

/**
 * Why do we need this wrapper function?
 *
 * By using a generic `Function` type for the callback parameter, we bypass strict type
 * checking temporarily. This allows us to pass a standard `Context` object, which we know
 * contains the correct event and payload types, to the callback safely.
 *
 * We can trust that the `ProxyCallbacks` type has already ensured that each callback function
 * matches the expected event and payload types, so this function provides a safe and
 * flexible way to handle callbacks without introducing type or logic errors.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export function handleCallback(callback: Function, context: Context) {
  return callback(context);
}
