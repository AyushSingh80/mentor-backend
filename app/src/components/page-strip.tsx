/**
 * The captured selection, as a horizontal strip of removable tiles.
 *
 * TERMINOLOGY. Everything user-facing here counts FILES, not pages. The cap the
 * server enforces, and the `pages` field it echoes back in `meta`, are both a
 * count of uploaded files — a scanned PDF containing four sheets of paper is
 * one of the twelve. Wording it as pages would tell her she had spent a third
 * of her budget on a single scan when she had spent a twelfth, and she would
 * split scans she never needed to split.
 *
 * PDFs get a labelled placeholder rather than a thumbnail. Rendering the first
 * page of a PDF needs a native PDF module, and that is not a trade worth making
 * on the screen used every day for a picture of something she just scanned and
 * can already identify by name.
 */

import { Image } from 'expo-image';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useTheme } from '@/components/form';
import { describeSelection, isPdf, type CapturedFile } from '@/lib/scan-rules';

const TILE = 96;

export function PageStrip({
  files,
  onRemove,
  disabled = false,
}: {
  files: CapturedFile[];
  onRemove: (index: number) => void;
  /** Set while an evaluation is in flight — the selection is being uploaded. */
  disabled?: boolean;
}) {
  const theme = useTheme();

  return (
    <View style={styles.root}>
      {files.length === 0 ? (
        <Text style={[styles.empty, { color: theme.textSecondary }]}>
          No files added yet. A scanned PDF of the whole answer counts as one file.
        </Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.strip}
        >
          {files.map((file, index) => (
            <Tile
              key={file.uri}
              file={file}
              index={index}
              theme={theme}
              disabled={disabled}
              onRemove={() => onRemove(index)}
            />
          ))}
        </ScrollView>
      )}

      <Text style={[styles.counter, { color: theme.textSecondary }]}>
        {describeSelection(files)}
      </Text>
    </View>
  );
}

interface Theme {
  text: string;
  textSecondary: string;
  backgroundElement: string;
  backgroundSelected: string;
}

function Tile({
  file,
  index,
  theme,
  disabled,
  onRemove,
}: {
  file: CapturedFile;
  index: number;
  theme: Theme;
  disabled: boolean;
  onRemove: () => void;
}) {
  const position = `File ${index + 1}`;

  return (
    <View style={styles.tileWrap}>
      <View style={[styles.tile, { backgroundColor: theme.backgroundElement }]}>
        {isPdf(file) ? (
          <PdfPlaceholder theme={theme} />
        ) : (
          <Image
            source={{ uri: file.uri }}
            style={styles.thumbnail}
            contentFit="cover"
            accessible
            accessibilityLabel={`${position}, ${file.name}`}
          />
        )}
      </View>

      <Text style={[styles.caption, { color: theme.textSecondary }]} numberOfLines={1}>
        {file.name}
      </Text>

      {/* 44x44 of touch area over a 26px badge: the visual weight stays small
          on a 96px tile while the target still clears the iOS HIG floor and
          the Material 48dp guidance is met on the diagonal. */}
      <TouchableOpacity
        onPress={onRemove}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${file.name}`}
        accessibilityHint={`Removes ${position} from this answer`}
        style={[styles.removeTarget, { opacity: disabled ? 0.4 : 1 }]}
      >
        <View style={[styles.removeBadge, { backgroundColor: theme.text }]}>
          <Text style={[styles.removeGlyph, { color: theme.backgroundElement }]}>×</Text>
        </View>
      </TouchableOpacity>
    </View>
  );
}

/** A document glyph — a rounded sheet with a folded corner — plus the label. */
function PdfPlaceholder({ theme }: { theme: Theme }) {
  return (
    <View style={styles.pdf}>
      <View style={[styles.pdfSheet, { borderColor: theme.textSecondary }]}>
        <View style={[styles.pdfFold, { backgroundColor: theme.textSecondary }]} />
      </View>
      <Text style={[styles.pdfLabel, { color: theme.text }]}>PDF</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8, marginBottom: 18 },
  empty: { fontSize: 13, lineHeight: 19 },
  counter: { fontSize: 12, fontVariant: ['tabular-nums'] },
  // Top padding leaves the remove badge room to sit on the tile corner
  // without the ScrollView clipping it on Android.
  strip: { gap: 12, paddingTop: 6, paddingRight: 4 },
  tileWrap: { width: TILE, paddingTop: 6 },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: 10,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnail: { width: '100%', height: '100%' },
  caption: { fontSize: 11, marginTop: 5 },
  removeTarget: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 44,
    height: 44,
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
  },
  removeBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeGlyph: { fontSize: 17, lineHeight: 20, fontWeight: '700' },
  pdf: { alignItems: 'center', gap: 8 },
  pdfSheet: { width: 26, height: 32, borderWidth: 1.6, borderRadius: 3 },
  pdfFold: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 9,
    height: 9,
    opacity: 0.55,
  },
  pdfLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
});
