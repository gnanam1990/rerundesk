# RerunDesk · Operator and customer experience

## Work surfaces and primary interaction

Sponsor config screen exposes versions, baseline, tolerance and declared hardware. Run page presents worker operator, spend and stage. Comparison shows reference and measured values, units, absolute difference and verdict; incomplete artifacts have named missing fields. Download manifest with redacted worker evidence.

**Walkthrough.** The sponsor registers a reference metric, dataset hash and tolerance, selects an eligible worker offer and authorizes capped compute. A worker runs the recipe, uploads a signed run bundle, and the evaluator compares the observed measurement with the precommitted rule. Sponsor downloads the result and its reproduction instructions.

## Interaction contract

Start a returning user in their permitted work queue. Open a record on a stable, shareable internal route. Keep input revisions, current state, decision explanation and evidence within the same case. Put actor, cost, scope and irreversible consequences beside the relevant confirmation. After submission, show the persisted operation ID and allow navigation away while the worker runs.

Support loading, empty, in-progress, pending external confirmation, denied, stale revision, completed-with-findings and unavailable states where applicable. Render server values after refresh. Preserve drafts on recoverable errors, show why a retry is or is not allowed, and make partial evidence individually identifiable.

## Accessibility acceptance

Use native controls, keyboard-visible focus, accessible names and text equivalents for status colors. On mobile show the primary task and decision before secondary details. Keep tables navigable with explicit headers, respect reduced motion, announce saved/submitted states and focus the first invalid field. Verify the case flow with keyboard-only navigation at 320 CSS pixels and with screen-reader status announcements. Include the client-appropriate redacted view in the browser proof.
