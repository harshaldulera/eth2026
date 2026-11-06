-- 0008_onboarding_fixes (onboarding review fix round): idempotent deposit handlers and deposit progress.
-- unit_drafts.account_key: the unit's ECDSA key, stored BEFORE the account-create transaction is sent, so a retry reuses the same alias (never a second funded account). Raw at rest, never returned.
-- deposit_intents.claimed_at: when the intent was claimed into `funding` (the worker un-sticks a crashed handler).
-- deposit_intents.step: setup progress "k/n label" the deposit panel shows as SETTING UP k/n.
ALTER TABLE `unit_drafts` ADD `account_key` text;--> statement-breakpoint
ALTER TABLE `deposit_intents` ADD `claimed_at` text;--> statement-breakpoint
ALTER TABLE `deposit_intents` ADD `step` text;
