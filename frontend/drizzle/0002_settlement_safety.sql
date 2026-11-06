ALTER TABLE `agent_spend` ADD `receipt_id` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `vault_address` text;--> statement-breakpoint
ALTER TABLE `payment_receipts` ADD `state` text DEFAULT 'settled' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_receipts` ADD `refund_tx` text;--> statement-breakpoint
ALTER TABLE `payment_receipts` ADD `note` text;--> statement-breakpoint
CREATE UNIQUE INDEX `payment_receipts_tx_id` ON `payment_receipts` (`tx_id`) WHERE "payment_receipts"."free" = 0 AND "payment_receipts"."stub" = 0 AND "payment_receipts"."tx_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `sieges` ADD `pending_tx` text;--> statement-breakpoint
ALTER TABLE `sieges` ADD `void_reason` text;