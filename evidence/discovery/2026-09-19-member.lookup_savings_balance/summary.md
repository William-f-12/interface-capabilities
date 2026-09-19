# Discovery — member.lookup_savings_balance on northstar

- goal: Finds a member by their member number, opens their account overview, and returns the savings balance along with the member's name and the account's status. Read-only: this capability never changes anything in the core.
- stopped because: **goal_reached**
- decided by: `deepseek-flash`
- steps taken: 10 of 22
- model tokens: 189153
- duration: 29237ms
- inputs: `{"member_id":"100005"}`

## The flow that was found

| # | action | why |
| --- | --- | --- |
| 1 | click | Open the Member Search page to look up the member by number. |
| 2 | type | Enter the member number into the Member ID field to look the member up. |
| 3 | click | Submit the Member ID search to find member 100005. |
| 4 | click | Open the member's account overview by following the View link in the search result row for the searched member number. |
| 5 | click | Open the Accounts tab to see the member's savings account balance and status. |
| 6 | read | Read the value in the Member Name row of the member info table, which holds the member's name as the core displays it. |
| 7 | read | Read the savings account's balance from the Accounts table row for the Savings account, under the Balance column. |
| 8 | read | Read the savings account's status from the Status column of the Accounts table row for the Savings account type, anchored by the stable row label and column header rather than the value itself. |

## Artifact

Compiled to `artifact.json`. It is a **draft**: nothing a model wrote is approved by writing it.

## What this run did not establish

- **No outcomes.** The run walked one path with one set of inputs, so it saw no
  business outcome and the artifact declares none. Replaying it against an input
  that produces one will report a missing checkpoint rather than the outcome.
- **Enum maps cover only what was on screen.** A display value this run never saw
  is left unmapped and fails loudly rather than being guessed at.
- **The full attempt history is in `trace.jsonl`,** including the guesses that did
  not work out. The artifact deliberately contains none of them.
