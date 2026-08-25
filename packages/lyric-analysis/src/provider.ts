import { analyzeLyrics, LYRIC_ANALYSIS_VERSION, type LyricAnalysisInput, type LyricAnalysisResult } from './analyze.js'

/**
 * The lyric-analysis provider seam.
 *
 * The heuristic implementation below is the default and needs nothing. A
 * language-model provider could be registered in its place for better syllable
 * and rhyme accuracy — but the interface deliberately takes lyrics as *input*
 * rather than offering to write them, because no implementation of this
 * interface is allowed to generate a lyric.
 */

export interface LyricAnalysisProvider {
  readonly providerId: string
  readonly modelVersion: string
  isConfigured(): boolean
  analyzeLyrics(input: LyricAnalysisInput): Promise<LyricAnalysisResult>
}

export class HeuristicLyricAnalysisProvider implements LyricAnalysisProvider {
  readonly providerId = 'heuristic-lyrics'
  readonly modelVersion = LYRIC_ANALYSIS_VERSION

  isConfigured(): boolean {
    return true
  }

  async analyzeLyrics(input: LyricAnalysisInput): Promise<LyricAnalysisResult> {
    return analyzeLyrics(input)
  }
}
