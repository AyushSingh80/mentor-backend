CREATE TABLE `drill_parts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drill_id` integer NOT NULL,
	`part` text NOT NULL,
	`content` text NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`drill_id`) REFERENCES `drills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drill_parts_key` ON `drill_parts` (`drill_id`,`part`);--> statement-breakpoint
CREATE TABLE `drill_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drill_id` integer NOT NULL,
	`part` text NOT NULL,
	`score` real NOT NULL,
	`max` real NOT NULL,
	`comment` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`drill_id`) REFERENCES `drills`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "drill_scores_within_max" CHECK("drill_scores"."score" >= 0 and "drill_scores"."score" <= "drill_scores"."max")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drill_scores_key` ON `drill_scores` (`drill_id`,`part`);--> statement-breakpoint
CREATE TABLE `drills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'banked' NOT NULL,
	`prompt_text` text NOT NULL,
	`case_detail` text,
	`syllabus_topic_id` integer,
	`banked_on` text NOT NULL,
	`batch_id` text,
	`prompt_version` text,
	`started_at` text,
	`submitted_at` text,
	`minutes_spent` integer,
	`total` real,
	`max` real,
	`feedback_md` text,
	`highest_leverage_fix` text,
	`rubric_version` text,
	`model` text,
	`error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`syllabus_topic_id`) REFERENCES `syllabus_topics`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "drills_case_detail_matches_kind" CHECK(("drills"."kind" = 'ethics_case' and "drills"."case_detail" is not null)
          or ("drills"."kind" <> 'ethics_case' and "drills"."case_detail" is null))
);
--> statement-breakpoint
CREATE INDEX `drills_status_idx` ON `drills` (`status`,`kind`);--> statement-breakpoint
CREATE INDEX `drills_banked_on_idx` ON `drills` (`banked_on`);--> statement-breakpoint
CREATE UNIQUE INDEX `drills_prompt_key` ON `drills` (`kind`,`prompt_text`);--> statement-breakpoint
CREATE TABLE `material_bank` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`attribution` text,
	`source_note` text,
	`syllabus_topic_id` integer,
	`ca_item_id` integer,
	`times_used` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`retired_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`syllabus_topic_id`) REFERENCES `syllabus_topics`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ca_item_id`) REFERENCES `ca_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `material_bank_topic_idx` ON `material_bank` (`syllabus_topic_id`);--> statement-breakpoint
CREATE INDEX `material_bank_kind_idx` ON `material_bank` (`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `material_bank_content_key` ON `material_bank` (`content`);