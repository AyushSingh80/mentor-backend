CREATE TABLE `answers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`paper` text NOT NULL,
	`question_text` text NOT NULL,
	`directive_word` text,
	`word_limit` integer DEFAULT 250 NOT NULL,
	`image_paths` text DEFAULT '[]' NOT NULL,
	`syllabus_topic_id` integer,
	`sync_status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`syllabus_topic_id`) REFERENCES `syllabus_topics`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `api_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`endpoint` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`est_cost_usd` real DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ca_digests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`date` text NOT NULL,
	`requested_at` text NOT NULL,
	`completed_at` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`trigger` text NOT NULL,
	`model` text,
	`prompt_version` text,
	`source_set_version` text,
	`considered_count` integer,
	`shortlisted_count` integer,
	`kept_count` integer,
	`dropped_count` integer,
	`drop_reasons_json` text,
	`source_failures_json` text,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ca_digests_request_id_key` ON `ca_digests` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ca_digests_date_key` ON `ca_digests` (`date`);--> statement-breakpoint
CREATE TABLE `ca_item_topics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ca_item_id` integer NOT NULL,
	`syllabus_topic_id` integer NOT NULL,
	`rank` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`ca_item_id`) REFERENCES `ca_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`syllabus_topic_id`) REFERENCES `syllabus_topics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ca_item_topics_key` ON `ca_item_topics` (`ca_item_id`,`syllabus_topic_id`);--> statement-breakpoint
CREATE INDEX `ca_item_topics_topic_idx` ON `ca_item_topics` (`syllabus_topic_id`);--> statement-breakpoint
CREATE TABLE `ca_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`published_at` text,
	`headline` text NOT NULL,
	`source_url` text,
	`source_name` text,
	`source_url_canonical` text,
	`item_kind` text DEFAULT 'event' NOT NULL,
	`syllabus_tags` text DEFAULT '[]' NOT NULL,
	`note_md` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`anthro_link` text,
	`anthro_p1_slug` text,
	`anthro_p2_slug` text,
	`read_at` text,
	`headline_fingerprint` text DEFAULT '' NOT NULL,
	`digest_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`digest_id`) REFERENCES `ca_digests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ca_items_date_idx` ON `ca_items` (`date`);--> statement-breakpoint
CREATE INDEX `ca_items_fingerprint_idx` ON `ca_items` (`headline_fingerprint`);--> statement-breakpoint
CREATE INDEX `ca_items_canonical_url_idx` ON `ca_items` (`source_url_canonical`);--> statement-breakpoint
CREATE INDEX `ca_items_digest_idx` ON `ca_items` (`digest_id`);--> statement-breakpoint
CREATE TABLE `daf_profile` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evaluation_dimensions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evaluation_id` integer NOT NULL,
	`name` text NOT NULL,
	`score` real NOT NULL,
	`max` real NOT NULL,
	`comment` text,
	FOREIGN KEY (`evaluation_id`) REFERENCES `evaluations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evaluation_dimensions_evaluation_id_idx` ON `evaluation_dimensions` (`evaluation_id`);--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`answer_id` integer NOT NULL,
	`model` text NOT NULL,
	`rubric_version` text NOT NULL,
	`total` real NOT NULL,
	`max` real NOT NULL,
	`directive_word` text,
	`directive_compliance` integer,
	`feedback_md` text NOT NULL,
	`model_skeleton_md` text,
	`highest_leverage_fix` text,
	`legibility` text,
	`word_limit_respected` integer,
	`confidence` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`answer_id`) REFERENCES `answers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evaluations_answer_id_idx` ON `evaluations` (`answer_id`);--> statement-breakpoint
CREATE TABLE `flashcards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`syllabus_topic_id` integer,
	`front` text NOT NULL,
	`back` text NOT NULL,
	`due_at` text NOT NULL,
	`interval_days` real DEFAULT 1 NOT NULL,
	`ease_factor` real DEFAULT 2.5 NOT NULL,
	`repetitions` integer DEFAULT 0 NOT NULL,
	`last_reviewed_at` text,
	`lapses` integer DEFAULT 0 NOT NULL,
	`ca_item_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`syllabus_topic_id`) REFERENCES `syllabus_topics`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ca_item_id`) REFERENCES `ca_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `flashcards_due_at_idx` ON `flashcards` (`due_at`);--> statement-breakpoint
CREATE TABLE `lectures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`course` text NOT NULL,
	`subject` text NOT NULL,
	`title` text NOT NULL,
	`runtime_min` integer NOT NULL,
	`released_on` text NOT NULL,
	`watched_on` text,
	`skipped_on` text,
	`playback_speed` real,
	`notes_made` integer DEFAULT false NOT NULL,
	`syllabus_topic_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`syllabus_topic_id`) REFERENCES `syllabus_topics`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `mcq_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_id` integer NOT NULL,
	`chosen_index` integer,
	`correct` integer NOT NULL,
	`time_taken_sec` integer,
	`guessed` integer DEFAULT false NOT NULL,
	`session_id` integer,
	`attempted_at` text NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `mcq_questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `mcq_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "mcq_attempts_skip_not_correct" CHECK(("mcq_attempts"."chosen_index" is not null) or ("mcq_attempts"."correct" = 0))
);
--> statement-breakpoint
CREATE INDEX `mcq_attempts_question_id_idx` ON `mcq_attempts` (`question_id`);--> statement-breakpoint
CREATE INDEX `mcq_attempts_session_id_idx` ON `mcq_attempts` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcq_attempts_session_question_key` ON `mcq_attempts` (`session_id`,`question_id`);--> statement-breakpoint
CREATE TABLE `mcq_bank_refills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`requested_at` text NOT NULL,
	`completed_at` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`trigger` text NOT NULL,
	`requested_count` integer NOT NULL,
	`received_count` integer,
	`accepted_count` integer,
	`batch_id` text,
	`error` text,
	`plan_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcq_bank_refills_request_id_key` ON `mcq_bank_refills` (`request_id`);--> statement-breakpoint
CREATE TABLE `mcq_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`syllabus_topic_id` integer,
	`stem` text NOT NULL,
	`options_json` text NOT NULL,
	`correct_index` integer NOT NULL,
	`elimination_logic` text,
	`difficulty` text DEFAULT 'medium' NOT NULL,
	`source` text,
	`pyq_year` integer,
	`pyq_paper` text,
	`batch_id` text,
	`external_id` text,
	`stem_fingerprint` text DEFAULT '' NOT NULL,
	`disputed_at` text,
	`dispute_reason` text,
	`dispute_note` text,
	`dispute_resolved_at` text,
	`dispute_verdict` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`syllabus_topic_id`) REFERENCES `syllabus_topics`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcq_questions_external_id_key` ON `mcq_questions` (`external_id`);--> statement-breakpoint
CREATE INDEX `mcq_questions_fingerprint_idx` ON `mcq_questions` (`stem_fingerprint`);--> statement-breakpoint
CREATE INDEX `mcq_questions_batch_idx` ON `mcq_questions` (`batch_id`);--> statement-breakpoint
CREATE TABLE `mcq_review_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_id` integer NOT NULL,
	`due_at` text NOT NULL,
	`interval_days` real DEFAULT 1 NOT NULL,
	`ease_factor` real DEFAULT 2.5 NOT NULL,
	`repetitions` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`last_reviewed_at` text,
	`enrolled_at` text NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `mcq_questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcq_review_queue_question_key` ON `mcq_review_queue` (`question_id`);--> statement-breakpoint
CREATE INDEX `mcq_review_queue_due_at_idx` ON `mcq_review_queue` (`due_at`);--> statement-breakpoint
CREATE TABLE `mcq_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`study_date` text NOT NULL,
	`planned_count` integer NOT NULL,
	`duration_target_sec` integer,
	`mark_per_correct` real DEFAULT 2 NOT NULL,
	`mark_per_wrong` real DEFAULT -0.6666666666666666 NOT NULL,
	`selection_reason` text
);
--> statement-breakpoint
CREATE INDEX `mcq_sessions_study_date_idx` ON `mcq_sessions` (`study_date`);--> statement-breakpoint
CREATE TABLE `profile` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`job_start_minutes` integer NOT NULL,
	`job_end_minutes` integer NOT NULL,
	`work_days` text DEFAULT '[1,2,3,4,5]' NOT NULL,
	`commute_minutes_each_way` integer DEFAULT 0 NOT NULL,
	`wake_minutes` integer NOT NULL,
	`sleep_minutes` integer NOT NULL,
	`default_playback_speed` real DEFAULT 1.5 NOT NULL,
	`gs_course_total_lectures` integer,
	`gs_course_total_runtime_min` integer,
	`anthro_class_days` text DEFAULT '[]' NOT NULL,
	`target_first_pass_date` text DEFAULT '2027-03-31' NOT NULL,
	`exam_year` integer DEFAULT 2028 NOT NULL,
	`timezone` text DEFAULT 'Asia/Kolkata' NOT NULL,
	`onboarded_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `revision_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`syllabus_topic_id` integer NOT NULL,
	`due_at` text NOT NULL,
	`interval_days` real DEFAULT 1 NOT NULL,
	`ease_factor` real DEFAULT 2.5 NOT NULL,
	`repetitions` integer DEFAULT 0 NOT NULL,
	`last_reviewed_at` text,
	`lapses` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`syllabus_topic_id`) REFERENCES `syllabus_topics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revision_queue_topic_key` ON `revision_queue` (`syllabus_topic_id`);--> statement-breakpoint
CREATE TABLE `revision_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`syllabus_topic_id` integer,
	`flashcard_id` integer,
	`grade` integer NOT NULL,
	`prev_interval_days` real NOT NULL,
	`new_interval_days` real NOT NULL,
	`prev_ease` real NOT NULL,
	`new_ease` real NOT NULL,
	`reviewed_at` text NOT NULL,
	FOREIGN KEY (`syllabus_topic_id`) REFERENCES `syllabus_topics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`flashcard_id`) REFERENCES `flashcards`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "revision_reviews_exactly_one_target" CHECK(("revision_reviews"."syllabus_topic_id" is not null) <> ("revision_reviews"."flashcard_id" is not null))
);
--> statement-breakpoint
CREATE INDEX `revision_reviews_topic_idx` ON `revision_reviews` (`syllabus_topic_id`);--> statement-breakpoint
CREATE INDEX `revision_reviews_flashcard_idx` ON `revision_reviews` (`flashcard_id`);--> statement-breakpoint
CREATE TABLE `study_blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_of_week` integer NOT NULL,
	`start_minutes` integer NOT NULL,
	`end_minutes` integer NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`generated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `study_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`block` text,
	`planned_hours` real,
	`actual_hours` real DEFAULT 0 NOT NULL,
	`subjects` text DEFAULT '[]' NOT NULL,
	`mood` integer,
	`energy` integer,
	`notes` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `syllabus_topics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`paper` text NOT NULL,
	`topic` text NOT NULL,
	`subtopic` text,
	`position` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`first_pass_at` text,
	`revised_at` text,
	`confidence` integer,
	`retired_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `syllabus_topics_slug_key` ON `syllabus_topics` (`slug`);