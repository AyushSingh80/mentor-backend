CREATE TABLE `interview_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`field` text,
	`area` text NOT NULL,
	`question` text NOT NULL,
	`likelihood` text DEFAULT 'possible' NOT NULL,
	`prep` text DEFAULT 'not_started' NOT NULL,
	`notes` text,
	`flagged` integer DEFAULT false NOT NULL,
	`batch_id` text,
	`prompt_version` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interview_questions_area_idx` ON `interview_questions` (`area`);--> statement-breakpoint
CREATE INDEX `interview_questions_prep_idx` ON `interview_questions` (`prep`);--> statement-breakpoint
CREATE UNIQUE INDEX `interview_questions_text_key` ON `interview_questions` (`question`);--> statement-breakpoint
CREATE UNIQUE INDEX `daf_profile_field_key` ON `daf_profile` (`field`);