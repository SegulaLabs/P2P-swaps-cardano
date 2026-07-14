# Audit regression tests (Fable 5)

`audit_fable5_tests.ak` is the evidence/regression suite for the findings in
`../security-audit-fable5.md`. It was authored and executed **in-tree** during the audit
(all 5 tests pass, bringing the Aiken suite to 135 passing), then moved here so the
protocol source tree is left unmodified per the engagement rules.

## What each test proves

| Test | Finding | Meaning of "pass" |
|---|---|---|
| `audit_oversized_ask_asset_name_mints_unfillable_order` | F-02 | The mint policy **accepts** an unfillable order (40-byte ask asset name). A fix should flip this to fail. |
| `audit_permissionless_creation_spoofs_owner` | F-03 | The mint policy **accepts** an order attributed to an arbitrary owner with no owner signature. |
| `audit_two_full_takes_one_doubled_payment_second_fails` | double-satisfaction | The validator **rejects** two full takes sharing one doubled-value payment (this is a `fail` test — passing means correctly rejected). |
| `audit_partial_rounding_never_favors_taker` | I5 | `ceil(take*ask/offer)` never lets the taker underpay, brute-forced over small ratios. |
| `audit_partial_continuation_ask_stays_positive` | I4/I5 | Accepted partials always leave a well-formed (`ask' > 0`) continuation. |

## How to re-run

The file depends on the in-repo test fixtures (`tests/fixtures`), so it must live inside
the Aiken project to compile:

```sh
cp Audit/regression-tests/audit_fable5_tests.ak contracts/lib/tests/
cd contracts
# aiken v1.1.23 (npm distro for aarch64 dev containers):
npx --yes @aiken-lang/aiken check | grep -E '"title"|"status"'
# clean up afterwards to keep the source tree unmodified:
rm contracts/lib/tests/audit_fable5_tests.ak
```

Expected: the three `audit_*` positive/`fail` tests and the two rounding tests all report
`"status": "pass"`.
