# Sources

Every statement in this repository about Stripe comes from one of the three pages below.
They were fetched with `curl -sL` on **Tue Nov  3 19:27:42 UTC 2026** (output of `date -u`), as the
raw Markdown versions, and each quoted sentence was checked to appear literally in the fetched
text. Nothing about Stripe is stated from memory. Anything the pages do not say is listed as an
assumption in the README under Limits.

- <https://docs.stripe.com/webhooks.md>
- <https://docs.stripe.com/api/events/types.md>
- <https://docs.stripe.com/api/idempotent_requests.md>

## Faults the webhook harness produces

### The same event delivered twice (F1)

Page: <https://docs.stripe.com/webhooks.md>

> Webhook endpoints might occasionally receive the same event more than once.

### Two separate events (different ids) for the same occurrence (F2)

Page: <https://docs.stripe.com/webhooks.md>

> In some cases, two separate Event objects are generated and sent. To identify these duplicates, use the ID of the object in `data.object` along with the `event.type`.

### Events delivered out of order (F3)

Page: <https://docs.stripe.com/webhooks.md>

> Stripe doesn’t guarantee the delivery of events in the order that they’re generated.

> You can also use the API to retrieve any missing objects.

The page also says: "Don’t use `created` to determine event order or whether you’ve already
processed an event." For that reason the harness uses `created` only to pick the reconciliation
day, never to order events.

## Event shapes

Page: <https://docs.stripe.com/api/events/types.md>

`charge.refunded` carries the charge, including partial refunds: the page lists `charge` as the
type of its `data.object` and describes the event as:

> Occurs whenever a charge is refunded, including partial refunds. Listen to `refund.created` for information about the refund.

For that reason the ledger moves refund money only from `refund.created`, keyed by the refund id,
and records nothing for `charge.refunded`. A refund announced by both events is reversed once (a
control spec checks it).

`refund.created` carries the refund (the page lists `refund` as the type of its `data.object`):

> Occurs whenever a refund is created.

The other event types the harness sends:

- `charge.succeeded` (a capture): "Occurs whenever a charge is successful."
- `charge.dispute.created` (a dispute): "Occurs whenever a customer disputes a charge with their bank."

The page also documents `payout.paid`, and says of it: "If the payout fails, a `payout.failed`
notification is also sent, at a later time." The payout scenario in this repository is driven
through the fake provider's payout endpoints, not through those two events (see Limits in the
README).

## Idempotency keys (F7)

Page: <https://docs.stripe.com/api/idempotent_requests.md>

> For API v1, Stripe saves the status code and body of the first request made with a given idempotency key after endpoint execution begins. Retries with the same key return the saved response, including `500` errors.

> Then, if a connection error occurs, you can safely repeat the request without risk of creating a second object or performing the update twice.

The fake provider's `POST /v1/captures` follows the first sentence: the same `Idempotency-Key`
returns the same stored response and a different key creates a new capture.

## Webhook signature (control, present in both versions)

Page: <https://docs.stripe.com/webhooks.md>

> Stripe requires the raw body of the request to perform signature verification.

> The timestamp has a `t=` prefix, and each signature has a *scheme* prefix.

> Compute an HMAC with the SHA256 hash function. Use the endpoint’s signing secret as the key, and use the `signed_payload` string as the message.

> To protect against timing attacks, use a constant-time-string comparison to compare the expected signature to each of the received signatures.

The page defines `signed_payload` as the timestamp (as a string), the character `.`, and the
actual JSON payload (the request body). The header the harness sends and the app verifies is
`t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
