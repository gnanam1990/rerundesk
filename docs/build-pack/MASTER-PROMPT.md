# RerunDesk · Master build prompt

Build RerunDesk in the repository supplied with this pack. The product's first complete journey is the following.

The sponsor registers a reference metric, dataset hash and tolerance, selects an eligible worker offer and authorizes capped compute. A worker runs the recipe, uploads a signed run bundle, and the evaluator compares the observed measurement with the precommitted rule. Sponsor downloads the result and its reproduction instructions.

## Intake

Read repository instructions and inspect the current branch, HEAD, uncommitted work, existing architecture, locked dependencies, test commands and any ongoing implementation. Check [source baselines](SOURCES.md) before reusing upstream work. Record whether this is a dedicated greenfield project or an extension. For an existing implementation, trace each claimed capability from its real entry point before assigning completion. Preserve user changes.

## Build

Follow [the module index](MODULES.md). Drive changes from observable failing behavior. Implement actual domain rules, authorization, UI/API, storage and recovery. Use test doubles for deterministic fault injection and pair them with real local integration tests. Keep independent work moving when a partner dependency blocks one path. Expose each blocked external feature honestly in the UI and status ledger.

## Evidence and exit

Reference accuracy 0.900 with absolute tolerance 0.010 and one predeclared seed. Evaluator recomputes 890 correct out of 1000 as 0.890, so boundary difference 0.010 reproduces. A separate run with 889 correct diverges at 0.011. Missing 1 output makes the run inconclusive. All three verdicts are distinct from worker payment status.

Show the normal workflow in a clean checkout, exercise failure and restart, and leave evidence tied to the exact tested revision. A recorded demo uses the running product and permitted inputs. Verify logs, screenshots and exports are redacted. Local building and testing begin when the owner invokes this prompt for the supplied target. Remote publishing, deployment, paid calls, account creation, signing and public submissions need action-specific authority. Use the owner’s existing grants when applicable.

After every module, and before yielding, update the [continuation records](DELIVERY.md). Tell the next agent what already works, what failed, the last command, and the first concrete operation to perform.
