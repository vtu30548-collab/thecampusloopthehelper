# Testing notes

## Automated
`node test/smoke.js` boots a fresh server on a temporary database and runs 60 assertions across:
authentication & role boundaries - listing a resource - smart search - eligibility gates (verification, member type, training) - duration, opening-hour, weekly-quota and open-request limits - live preview - approval / rejection (reason required) - privacy (other users' bookings, requester contact hidden until approval) - check-in / check-out - auto-incident on worse condition - deposit withholding - incident resolution & strike - appeal & independent admin overturn - audit completeness and hash-chain verification - conflict prevention (409) - cancellation -> waitlist promotion - supervised check-in rule - auto-approval - overdue detection & notification - fair-use watch.

## Manual journeys (verified in a real browser)
1. Student: login -> search -> preview -> auto-approved booking -> check-in -> return (condition dropped) -> incident auto-opened.
2. Owner: confirm return -> incident list -> resolve with penalty.
3. Admin: audit trail loads, chain verified, fair-use table, mobile layout (390 px) has no horizontal overflow.

## Known quirks
- Check-in outside the slot is allowed only in demo mode (`DEMO_MODE=true`). In production it opens 30 minutes before the start.
- A booking not checked in 30 minutes after its start becomes *no-show* and opens an incident (no automatic penalty).
