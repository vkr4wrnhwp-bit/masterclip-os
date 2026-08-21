/**
 * JSON Schemas for forced tool output.
 *
 * Kept narrow on purpose: a schema wide enough to accept anything gives the
 * model room to return prose in a field the pipeline treats as structure.
 */
export const CREATIVE_BRIEF_SCHEMA = {
  name: 'creative_direction',
  description: 'Interpret a client brief into a project visual language and a scene breakdown.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['visual_language', 'scenes', 'negative_constraints', 'open_questions'],
    properties: {
      visual_language: { type: 'string', description: 'One paragraph the whole project is judged against.' },
      reference_films: { type: 'array', items: { type: 'string' } },
      color_palette: { type: 'array', items: { type: 'string' } },
      scenes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'synopsis', 'shot_count'],
          properties: {
            name: { type: 'string' },
            synopsis: { type: 'string' },
            shot_count: { type: 'integer', minimum: 1, maximum: 40 },
            narrative_function: { type: 'string' },
          },
        },
      },
      negative_constraints: { type: 'array', items: { type: 'string' } },
      open_questions: {
        type: 'array',
        description: 'Things the brief does not specify and that must not be invented.',
        items: { type: 'string' },
      },
    },
  },
} as const

export const SHOT_DESIGN_SCHEMA = {
  name: 'shot_design',
  description: 'Emit structured shots conforming to the canonical shot schema.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['shots'],
    properties: {
      shots: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'shot_id',
            'title',
            'narrative_purpose',
            'shot_category',
            'action',
            'performance_direction',
            'blocking',
            'camera_position',
            'camera_movement',
            'lens_mm',
            'aperture',
            'lighting',
            'duration_seconds',
            'screen_direction',
          ],
          properties: {
            shot_id: { type: 'string' },
            title: { type: 'string' },
            narrative_purpose: { type: 'string' },
            shot_category: {
              type: 'string',
              enum: ['performance', 'portrait', 'action', 'product', 'environment', 'insert_detail', 'transition', 'crowd', 'vehicle', 'abstract'],
            },
            action: { type: 'string' },
            performance_direction: { type: 'string' },
            blocking: { type: 'string' },
            camera_position: { type: 'string' },
            camera_movement: { type: 'string' },
            lens_mm: { type: 'number', minimum: 8, maximum: 400 },
            aperture: { type: 'number', minimum: 0.7, maximum: 32 },
            focus_behavior: { type: 'string' },
            duration_seconds: { type: 'number', minimum: 1, maximum: 20 },
            screen_direction: {
              type: 'string',
              enum: ['left_to_right', 'right_to_left', 'toward_camera', 'away_from_camera', 'static', 'unspecified'],
            },
            lighting: {
              type: 'object',
              additionalProperties: false,
              required: ['dominant_source', 'source_position', 'shadow_behavior'],
              properties: {
                dominant_source: { type: 'string' },
                source_position: { type: 'string' },
                color_temperature: { type: 'string' },
                falloff: { type: 'string' },
                shadow_behavior: { type: 'string' },
              },
            },
            material_requirements: { type: 'array', items: { type: 'string' } },
            environmental_motion: { type: 'array', items: { type: 'string' } },
            physical_motion_rules: { type: 'array', items: { type: 'string' } },
            negative_constraints: { type: 'array', items: { type: 'string' } },
            continuity_from_shot: { type: 'string' },
          },
        },
      },
    },
  },
} as const

export const ROUTING_ADVICE_SCHEMA = {
  name: 'routing_advice',
  description: 'Advise on model selection given a pre-computed ranking.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['recommended_provider', 'recommended_model', 'agrees_with_ranking', 'rationale', 'confidence'],
    properties: {
      recommended_provider: { type: 'string' },
      recommended_model: { type: 'string' },
      agrees_with_ranking: { type: 'boolean' },
      rationale: { type: 'string' },
      risks: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
} as const

export const CONTINUITY_REPORT_SCHEMA = {
  name: 'continuity_report',
  description: 'Report substantiated continuity breaks across a shot chain.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['breaks', 'chain_is_consistent'],
    properties: {
      chain_is_consistent: { type: 'boolean' },
      breaks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['shot_id', 'dimension', 'description', 'severity', 'fix'],
          properties: {
            shot_id: { type: 'string' },
            dimension: {
              type: 'string',
              enum: ['identity', 'wardrobe', 'prop', 'environment', 'screen_direction', 'eye_line', 'lighting', 'momentum', 'geometry'],
            },
            description: { type: 'string' },
            severity: { type: 'string', enum: ['blocking', 'noticeable', 'minor'] },
            fix: { type: 'string' },
          },
        },
      },
    },
  },
} as const

export const QC_ADJUDICATION_SCHEMA = {
  name: 'qc_adjudication',
  description: 'Adjudicate an uncertain QC verdict.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['recommended_action', 'rationale', 'confidence'],
    properties: {
      recommended_action: {
        type: 'string',
        enum: ['AUTO_REJECT', 'HUMAN_REVIEW', 'APPROVE_FOR_DRAFT', 'REGENERATE_WITH_CORRECTION', 'SEND_TO_DIFFERENT_MODEL'],
      },
      rationale: { type: 'string' },
      correction: { type: 'string', description: 'Prompt or routing change to apply on regeneration.' },
      rejection_reasons: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'character_drift',
            'wrong_face',
            'wrong_wardrobe',
            'wrong_camera',
            'too_static',
            'too_much_motion',
            'artificial_lighting',
            'ai_appearance',
            'bad_hands',
            'bad_physics',
            'weak_narrative',
            'wrong_environment',
            'poor_framing',
            'texture_flicker',
            'not_commercially_usable',
            'technical_failure',
            'other',
          ],
        },
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
} as const

export const COST_ADVICE_SCHEMA = {
  name: 'cost_advice',
  description: 'Judge whether a budget-legal spend is actually a good idea.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['proceed', 'rationale', 'confidence'],
    properties: {
      proceed: { type: 'boolean' },
      rationale: { type: 'string' },
      cheaper_alternative: { type: 'string' },
      expected_saving_usd: { type: 'number' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
} as const
