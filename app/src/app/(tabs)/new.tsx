/**
 * New answer — capture, then evaluate.
 *
 * The order of the screen is the order of the real workflow: she has already
 * written the answer on paper and scanned it, so the capture controls sit above
 * the fold and the PDF button is the primary one. Camera and gallery are there
 * for the odd single sheet, not for the daily path.
 *
 * Two rules shape the submit logic.
 *
 * `runEvaluation` never rejects — every failure, including cancellation, comes
 * back through `onFailed` — so there is no try/catch around it. Wrapping it
 * would be dead code that implies a rejection path exists and invites the next
 * reader to handle failures in two places.
 *
 * The pickers, by contrast, DO throw: a declined permission and a failed
 * durable copy both surface as exceptions, and both are caught here.
 *
 * Failure is not loss. `runEvaluation` saves the answer before it touches the
 * network, so a dead connection leaves a queued answer in History rather than
 * an empty form — which is why the error block says so explicitly instead of
 * just showing a message and letting her assume her work is gone.
 */

import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { ChipPicker, MultilineField, type ChipOption } from '@/components/controls';
import { Field, useTheme } from '@/components/form';
import { PageStrip } from '@/components/page-strip';
import { StreamingFeedback, type StreamingFeedbackHandle } from '@/components/streaming-feedback';
import { DIRECTIVES, PAPERS, type PaperValue } from '@/db/answers';
import { runEvaluation, type EvaluationPhase } from '@/lib/evaluation';
import {
  pickImages,
  pickPdf,
  takePhoto,
  validateSelection,
  type CapturedFile,
} from '@/lib/scan';

type Directive = (typeof DIRECTIVES)[number];

/** The server rejects a question longer than this, so stop it at the keyboard. */
const MAX_QUESTION = 2000;
const DEFAULT_WORD_LIMIT = 250;

const DIRECTIVE_OPTIONS: readonly ChipOption<Directive>[] = DIRECTIVES.map((word) => ({
  value: word,
  label: word.charAt(0).toUpperCase() + word.slice(1),
}));

/**
 * What each phase means in her words. `saved` and `failed` are terminal states
 * the error block and the redirect already speak for, so they stay quiet here.
 */
const PHASE_TEXT: Record<EvaluationPhase, string | null> = {
  idle: null,
  saving: 'Saving your answer…',
  uploading: 'Uploading your files…',
  streaming: 'Reading your answer…',
  scoring: 'Scoring against the rubric…',
  saved: 'Saved.',
  failed: null,
  offline: 'No connection — queued to retry later.',
};

export default function NewAnswer() {
  const theme = useTheme();
  const router = useRouter();

  const [paper, setPaper] = useState<PaperValue | null>(null);
  const [question, setQuestion] = useState('');
  const [directive, setDirective] = useState<Directive | null>(null);
  const [wordLimitText, setWordLimitText] = useState(String(DEFAULT_WORD_LIMIT));
  const [files, setFiles] = useState<CapturedFile[]>([]);

  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [phase, setPhase] = useState<EvaluationPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [savedAnswerId, setSavedAnswerId] = useState<number | null>(null);

  const abort = useRef<AbortController | null>(null);
  // Tokens go straight into the component, so streaming re-renders the feedback
  // panel and nothing else on this screen.
  const feedback = useRef<StreamingFeedbackHandle>(null);

  /**
   * Shared wrapper for the three capture buttons. An empty result means the
   * user backed out of the picker, which is not an error and must not clear a
   * message she has not read yet.
   */
  async function capture(run: () => Promise<CapturedFile[]>) {
    try {
      const captured = await run();
      if (captured.length === 0) return;
      setFiles((current) => [...current, ...captured]);
      setError(null);
    } catch (err) {
      setError((err as Error).message || 'Those files could not be added.');
    }
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index));
  }

  function resetForm() {
    setPaper(null);
    setQuestion('');
    setDirective(null);
    setWordLimitText(String(DEFAULT_WORD_LIMIT));
    setFiles([]);
    setPhase('idle');
    setError(null);
    setSavedAnswerId(null);
    feedback.current?.reset();
  }

  function submit() {
    // The file rules first, and through `validateSelection` rather than a
    // hand-rolled check — it mirrors the server's own limits, so anything it
    // accepts the server accepts, and anything it rejects fails here in a
    // sentence instead of after a slow upload and an opaque 400.
    const selection = validateSelection(files);
    if (!selection.ok) {
      setError(selection.reason ?? 'That selection cannot be uploaded.');
      return;
    }
    if (paper === null) {
      setError('Choose which paper this answer is for.');
      return;
    }
    const trimmed = question.trim();
    if (trimmed.length === 0) {
      setError('Add the question this answer responds to.');
      return;
    }
    const wordLimit = Number.parseInt(wordLimitText, 10);
    if (!Number.isFinite(wordLimit) || wordLimit <= 0) {
      setError('Set a word limit above zero.');
      return;
    }

    setError(null);
    setSavedAnswerId(null);
    feedback.current?.reset();

    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setCancelling(false);
    setPhase('saving');

    void runEvaluation(
      {
        paper,
        question: trimmed,
        directiveWord: directive ?? undefined,
        wordLimit,
        pages: files,
        signal: controller.signal,
      },
      {
        onPhase: setPhase,
        onAnswerCreated: setSavedAnswerId,
        onToken: (chunk) => feedback.current?.append(chunk),
        onFailed: (reason, answerId) => {
          abort.current = null;
          setBusy(false);
          setCancelling(false);
          setError(reason);
          setSavedAnswerId(answerId);
        },
        onDone: (result) => {
          abort.current = null;
          setBusy(false);
          setCancelling(false);
          // Reset before navigating: the tab screen stays mounted underneath
          // the answer detail, so without this the next capture starts on top
          // of the last one's question and files.
          resetForm();
          router.replace(`/answer/${result.answerId}`);
        },
      },
    );
  }

  function cancel() {
    setCancelling(true);
    // Aborting is all that happens here. The teardown — busy, phase, error —
    // is left to `onFailed`, so a cancelled run and a failed one settle through
    // exactly one path.
    abort.current?.abort();
  }

  const status = PHASE_TEXT[phase];

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        New answer
      </Text>
      <Text style={[styles.lede, { color: theme.textSecondary }]}>
        Scan your written answer with your phone&apos;s scanner app, then pick the PDF here.
      </Text>

      {/* Essay and Ethics practice is answer practice at a fifth of the length,
          so it belongs on this screen rather than on a fifth tab — four is the
          Material legibility floor and the bar is already at it. */}
      <TouchableOpacity
        onPress={() => router.push('/practice')}
        accessibilityRole="button"
        accessibilityLabel="Open Essay and Ethics practice"
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={styles.practice}
      >
        <Text style={[styles.practiceText, { color: theme.text }]}>
          Essay &amp; Ethics practice →
        </Text>
        <Text style={[styles.practiceHint, { color: theme.textSecondary }]}>
          A 20-minute outline, or a case answered part by part. Shorter than a full answer and
          scored per part.
        </Text>
      </TouchableOpacity>

      <Text style={[styles.section, { color: theme.text }]}>Your files</Text>

      <CaptureButton
        title="Pick scanned PDF"
        hint="The whole answer as one file"
        primary
        disabled={busy}
        onPress={() => void capture(pickPdf)}
      />
      <View style={styles.captureRow}>
        <CaptureButton
          title="Take photo"
          disabled={busy}
          onPress={() =>
            void capture(async () => {
              const photo = await takePhoto();
              return photo ? [photo] : [];
            })
          }
        />
        <CaptureButton
          title="Choose from gallery"
          disabled={busy}
          onPress={() => void capture(pickImages)}
        />
      </View>

      <PageStrip files={files} onRemove={removeFile} disabled={busy} />

      <Text style={[styles.section, { color: theme.text }]}>The question</Text>

      <ChipPicker<PaperValue>
        label="Paper"
        options={PAPERS}
        selected={paper}
        onSelect={setPaper}
      />

      <MultilineField
        label="Question"
        hint="Paste or type the question exactly as it was asked."
        value={question}
        onChangeText={setQuestion}
        placeholder="Discuss the role of…"
        minHeight={110}
        maxLength={MAX_QUESTION}
      />

      <ChipPicker<Directive>
        label="Directive word"
        hint="Optional. Tap again to clear — answering &quot;critically examine&quot; as if it were &quot;describe&quot; is the costliest Mains error."
        options={DIRECTIVE_OPTIONS}
        selected={directive}
        onSelect={(value) => setDirective((current) => (current === value ? null : value))}
      />

      <Field
        label="Word limit"
        hint="The limit the question set, not your actual count."
        value={wordLimitText}
        onChangeText={setWordLimitText}
        keyboardType="numeric"
        placeholder={String(DEFAULT_WORD_LIMIT)}
      />

      {status ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.status, { color: theme.textSecondary }]}
        >
          {status}
        </Text>
      ) : null}

      <StreamingFeedback ref={feedback} theme={theme} />

      {error ? (
        <View style={styles.error} accessibilityLiveRegion="polite">
          <Text style={[styles.errorText, { color: theme.text }]}>{error}</Text>
          {savedAnswerId !== null ? (
            <Text style={[styles.errorNote, { color: theme.text }]}>
              Your answer is saved. Retry it from History when you have signal.
            </Text>
          ) : null}
        </View>
      ) : null}

      <TouchableOpacity
        onPress={submit}
        disabled={busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        style={[styles.submit, { backgroundColor: theme.text, opacity: busy ? 0.4 : 1 }]}
      >
        <Text style={[styles.submitText, { color: theme.background }]}>
          {busy ? 'Evaluating…' : 'Evaluate answer'}
        </Text>
      </TouchableOpacity>

      {busy ? (
        <TouchableOpacity
          onPress={cancel}
          disabled={cancelling}
          accessibilityRole="button"
          accessibilityLabel="Cancel evaluation"
          style={styles.cancel}
        >
          <Text style={[styles.cancelText, { color: theme.textSecondary }]}>
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </Text>
        </TouchableOpacity>
      ) : null}

      <View style={{ height: 64 }} />
    </ScrollView>
  );
}

function CaptureButton({
  title,
  hint,
  primary = false,
  disabled = false,
  onPress,
}: {
  title: string;
  hint?: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={hint ? `${title}. ${hint}` : title}
      accessibilityState={{ disabled }}
      style={[
        styles.capture,
        primary ? styles.capturePrimary : styles.captureSecondary,
        {
          backgroundColor: primary ? theme.text : theme.backgroundElement,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.captureText,
          { color: primary ? theme.background : theme.text, fontWeight: primary ? '700' : '600' },
        ]}
      >
        {title}
      </Text>
      {hint ? (
        <Text
          style={[
            styles.captureHint,
            { color: primary ? theme.background : theme.textSecondary },
          ]}
        >
          {hint}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  h1: { fontSize: 26, fontWeight: '700', marginBottom: 8 },
  lede: { fontSize: 14, lineHeight: 20, marginBottom: 24 },
  section: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 8,
    marginBottom: 12,
    opacity: 0.6,
  },
  capture: {
    borderRadius: 12,
    paddingHorizontal: 16,
    justifyContent: 'center',
    minHeight: 52,
    marginBottom: 10,
  },
  capturePrimary: { paddingVertical: 14 },
  captureSecondary: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  captureRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  captureText: { fontSize: 15 },
  captureHint: { fontSize: 12, marginTop: 3, opacity: 0.75 },
  status: { fontSize: 13, marginBottom: 14 },
  error: {
    backgroundColor: 'rgba(255,69,58,0.16)',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    gap: 6,
  },
  errorText: { fontSize: 14, lineHeight: 20 },
  errorNote: { fontSize: 13, lineHeight: 19, opacity: 0.75 },
  submit: { borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 4 },
  submitText: { fontSize: 16, fontWeight: '700' },
  practice: { minHeight: 44, justifyContent: 'center', marginBottom: 20, gap: 3 },
  practiceText: { fontSize: 15, fontWeight: '600' },
  practiceHint: { fontSize: 12, lineHeight: 17 },
  cancel: { minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: 4 },
  cancelText: { fontSize: 15 },
});
