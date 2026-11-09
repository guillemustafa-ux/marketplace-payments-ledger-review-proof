// Each footgun reverts exactly one v2 fix back to its v1 defect. `find` is the exact v2
// text and `replace` is the defective text. Applied to a temporary copy of the source, never
// the working tree.

export const EDITS = {
  f1: [
    {
      file: 'src/v2/ledger.ts',
      find: `      // FIX F1: store the event id under a unique constraint in the same transaction as the ledger entries.
      const inserted = await client.query(
        'insert into webhook_events (event_id, event_type) values ($1, $2) on conflict (event_id) do nothing',
        [event.id, event.type],
      );
      if ((inserted.rowCount ?? 0) === 0) {
        await client.query('commit');
        return;
      }
      const day = dayOf(event.created);`,
      replace: `      // DEFECT F1: the event id is not stored under a unique constraint, so a redelivered
      // event is processed a second time.
      const day = dayOf(event.created);`,
    },
  ],

  f2: [
    {
      file: 'src/common/schema.sql',
      find: `  created_at timestamptz not null default now(),
  unique (provider_object_id, entry_type)
);`,
      replace: `  created_at timestamptz not null default now()
);`,
    },
    {
      file: 'src/v2/ledger.ts',
      find: `  // FIX F2: key every ledger transaction by (provider object id, entry type).
  async function insertTransaction(
    client: PoolClient,
    providerObjectId: string,
    entryType: string,
    day: string,
  ): Promise<number | null> {
    const result = await client.query(
      \`insert into ledger_transactions (provider_object_id, entry_type, day)
       values ($1, $2, $3)
       on conflict (provider_object_id, entry_type) do nothing
       returning id\`,
      [providerObjectId, entryType, day],
    );
    return result.rows.length ? Number(result.rows[0].id) : null;
  }`,
      replace: `  // DEFECT F2: transactions are not keyed by (provider object id, entry type), so two
  // events for one occurrence create two transactions.
  async function insertTransaction(
    client: PoolClient,
    providerObjectId: string,
    entryType: string,
    day: string,
  ): Promise<number | null> {
    const result = await client.query(
      'insert into ledger_transactions (provider_object_id, entry_type, day) values ($1, $2, $3) returning id',
      [providerObjectId, entryType, day],
    );
    return Number(result.rows[0].id);
  }`,
    },
  ],

  f3: [
    {
      file: 'src/v2/ledger.ts',
      find: `    if (!charge) {
      // FIX F3: park a refund or dispute that arrives before its capture and apply it once the capture exists.
      await client.query(
        \`insert into pending_reversals (provider_object_id, kind, charge_id, amount_cents, day)
         values ($1, $2, $3, $4, $5)
         on conflict (provider_object_id, kind) do nothing\`,
        [reversal.id, reversal.kind, reversal.chargeId, reversal.amount, day],
      );
      return;
    }`,
      replace: `    if (!charge) {
      // DEFECT F3: a refund or dispute that arrives before its capture is dropped, so the creator keeps the full earnings.
      return;
    }`,
    },
  ],

  f4: [
    {
      file: 'src/v2/ledger.ts',
      find: `        // FIX F4: key the refund by the refund id, not the charge id.
        await reverse(client, { kind: 'refund', id: refund.id, chargeId: refund.charge, amount: refund.amount }, day);`,
      replace: `        // DEFECT F4: refunds are keyed by (charge id, type), so a second partial refund on the same charge is dropped.
        await reverse(client, { kind: 'refund', id: refund.charge, chargeId: refund.charge, amount: refund.amount }, day);`,
    },
  ],

  f5: [
    {
      file: 'src/v2/ledger.ts',
      find: `import { captureSplit, dayOf, reversalSplit } from '../common/math.js';`,
      replace: `import { captureSplit, dayOf, refundSplitRoundedPerLine } from '../common/math.js';`,
    },
    {
      file: 'src/v2/ledger.ts',
      find: `    // FIX F5: split against the running total already reversed, so the parts sum exactly and a full reversal in parts ends at zero.
    const split = reversalSplit(chargeAmount, alreadyReversed, amount);`,
      replace: `    // DEFECT F5: each line is rounded half-up independently, so the parts can be off by a cent.
    const split = refundSplitRoundedPerLine(chargeAmount, amount);`,
    },
  ],

  f6: [
    {
      file: 'src/v2/ledger.ts',
      find: `  async function reconcile(day: string): Promise<ReconcileDifference[]> {
    // FIX F6: compare AMOUNTS per creator per day, not counts.
    const ledger = await ledgerCaptureAmounts(pool, day);
    const response = await fetch(\`\${providerUrl}/v1/reconciliation?day=\${encodeURIComponent(day)}\`);
    const providerRows = (await response.json()) as { creator_id: string; amount_cents: number }[];
    const provider = new Map<string, number>();
    for (const row of providerRows) provider.set(row.creator_id, row.amount_cents);

    const differences: ReconcileDifference[] = [];
    for (const [creatorId, ledgerCents] of ledger) {
      const providerCents = provider.get(creatorId) ?? 0;
      if (ledgerCents !== providerCents) {
        differences.push({ creator_id: creatorId, ledger_cents: ledgerCents, provider_cents: providerCents });
      }
    }
    for (const [creatorId, providerCents] of provider) {
      if (!ledger.has(creatorId) && providerCents !== 0) {
        differences.push({ creator_id: creatorId, ledger_cents: 0, provider_cents: providerCents });
      }
    }
    return differences;
  }`,
      replace: `  async function reconcile(day: string): Promise<ReconcileDifference[]> {
    // DEFECT F6: compare only the number of captures, so an amount drift per creator stays green.
    const ledgerCount = await pool.query(
      "select count(*)::int as n from ledger_transactions where day = $1 and entry_type = 'capture'",
      [day],
    );
    const response = await fetch(\`\${providerUrl}/v1/reconciliation?day=\${encodeURIComponent(day)}\`);
    const providerRows = (await response.json()) as { creator_id: string; amount_cents: number }[];
    if (Number(ledgerCount.rows[0].n) === providerRows.length) return [];
    return [{ creator_id: '<count mismatch>', ledger_cents: Number(ledgerCount.rows[0].n), provider_cents: providerRows.length }];
  }`,
    },
  ],

  f7: [
    {
      file: 'src/v2/ledger.ts',
      find: `  async function capture(input: CaptureInput): Promise<{ ok: boolean }> {
    // FIX F7: one idempotency key per order, stored before the first send and reused on every retry.
    await pool.query('insert into capture_intents (order_id, idempotency_key) values ($1, $2) on conflict (order_id) do nothing', [
      input.order_id,
      randomUUID(),
    ]);
    const intent = await pool.query('select idempotency_key from capture_intents where order_id = $1', [input.order_id]);
    const charge = await sendCaptureWithRetry(input, String(intent.rows[0].idempotency_key));
    await recordCaptureFromApi(charge);
    return { ok: true };
  }`,
      replace: `  async function capture(input: CaptureInput): Promise<{ ok: boolean }> {
    const charge = await sendCaptureWithRetry(input);
    await recordCaptureFromApi(charge);
    return { ok: true };
  }`,
    },
    {
      file: 'src/v2/ledger.ts',
      find: `  async function sendCaptureWithRetry(input: CaptureInput, key: string): Promise<Charge> {
    let lastError: unknown = new Error('capture not attempted');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {`,
      replace: `  async function sendCaptureWithRetry(input: CaptureInput): Promise<Charge> {
    let lastError: unknown = new Error('capture not attempted');
    for (let attempt = 0; attempt < 5; attempt++) {
      // DEFECT F7: a fresh idempotency key per attempt; a retry after a lost response captures twice.
      const key = randomUUID();
      try {`,
    },
  ],

  f8: [
    {
      file: 'src/v2/ledger.ts',
      find: `    // FIX F8: a dispute reverses the creator earnings, the referral reward and the platform share, like a refund.
    await insertLines(client, txId, [
      { account: creatorAccount(charge.creator_id), amount: -split.creator },
      { account: referrerAccount(charge.referrer_id), amount: -split.referrer },
      { account: PLATFORM, amount: -split.platform },
      { account: EXTERNAL, amount },
    ]);`,
      replace: `    // DEFECT F8: a dispute reverses the creator earnings but leaves the referral reward and the platform share in place.
    await insertLines(
      client,
      txId,
      reversal.kind === 'dispute'
        ? [
            { account: creatorAccount(charge.creator_id), amount: -split.creator },
            { account: EXTERNAL, amount: split.creator },
          ]
        : [
            { account: creatorAccount(charge.creator_id), amount: -split.creator },
            { account: referrerAccount(charge.referrer_id), amount: -split.referrer },
            { account: PLATFORM, amount: -split.platform },
            { account: EXTERNAL, amount },
          ],
    );`,
    },
  ],

  f9: [
    {
      file: 'src/v2/ledger.ts',
      find: `  async function payout(input: PayoutInput): Promise<PayoutOutcome> {
    // FIX F9: persist the payout intent before the first send and read it on every request.
    const inserted = await pool.query(
      'insert into payout_intents (client_reference, status) values ($1, $2) on conflict (client_reference) do nothing',
      [input.client_reference, 'pending'],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      const intent = await pool.query('select status, payout_id from payout_intents where client_reference = $1', [
        input.client_reference,
      ]);
      const row = intent.rows[0] as { status: string; payout_id: string | null };
      if (row.status === 'paid' && row.payout_id) return { status: 'paid', payout_id: row.payout_id };
      // Pending or unknown: an earlier send may have reached the provider, so ask it first.
      const found = await lookupPayout(input.client_reference);
      if (found) {
        await markPayoutPaid(input, found.id, found.created ?? 1730000000);
        return { status: 'paid', payout_id: found.id };
      }
      // The provider has no payout for this reference: sending it now cannot pay twice.
    }
    return sendPayout(input);
  }`,
      replace: `  async function payout(input: PayoutInput): Promise<PayoutOutcome> {
    return sendPayout(input);
  }`,
    },
    {
      file: 'src/v2/ledger.ts',
      find: `  async function sendPayout(input: PayoutInput): Promise<PayoutOutcome> {
    try {
      const response = await fetch(\`\${providerUrl}/v1/payouts\`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: input.amount, client_reference: input.client_reference, destination: input.creator_id }),
      });
      if (response.ok) {
        const paid = (await response.json()) as { id: string; created?: number };
        await markPayoutPaid(input, paid.id, paid.created ?? 1730000000);
        return { status: 'paid', payout_id: paid.id };
      }
      await markPayoutUnknown(input.client_reference);
      return { status: 'unknown' };
    } catch {
      // Unknown outcome: look the payout up by client_reference. If the provider has none,
      // return unknown and do not resend here; the next request resolves it by lookup.
      const found = await lookupPayout(input.client_reference);
      if (found) {
        await markPayoutPaid(input, found.id, found.created ?? 1730000000);
        return { status: 'paid', payout_id: found.id };
      }
      await markPayoutUnknown(input.client_reference);
      return { status: 'unknown' };
    }
  }`,
      replace: `  async function sendPayout(input: PayoutInput): Promise<PayoutOutcome> {
    // DEFECT F9: after an unknown outcome the payout is resent blindly, paying twice.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetch(\`\${providerUrl}/v1/payouts\`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amount: input.amount, client_reference: input.client_reference, destination: input.creator_id }),
        });
        if (response.ok) {
          const paid = (await response.json()) as { id: string; created?: number };
          await markPayoutPaid(input, paid.id, paid.created ?? 1730000000);
          return { status: 'paid', payout_id: paid.id };
        }
        return { status: 'unknown' };
      } catch {
        // lost response: resend blindly
      }
    }
    return { status: 'unknown' };
  }`,
    },
  ],
};
