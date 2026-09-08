ALTER TABLE `answers` ADD `pyq_year` integer;--> statement-breakpoint
ALTER TABLE `answers` ADD `pyq_paper` text;--> statement-breakpoint
ALTER TABLE `drills` ADD `source` text;--> statement-breakpoint
ALTER TABLE `drills` ADD `pyq_year` integer;--> statement-breakpoint
ALTER TABLE `drills` ADD `pyq_paper` text;--> statement-breakpoint
ALTER TABLE `drills` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `drills` ADD `retired_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `drills_external_id_key` ON `drills` (`external_id`);--> statement-breakpoint
ALTER TABLE `profile` ADD `pyq_dataset_version` integer;