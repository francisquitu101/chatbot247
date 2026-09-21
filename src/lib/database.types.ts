export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      analyst_assumption_versions: {
        Row: {
          analyst_id: string
          assumption_id: string
          category: string
          confidence: number | null
          created_at: string
          evidence_id: string | null
          id: string
          name: string
          new_value_numeric: number | null
          new_value_text: string | null
          previous_value_numeric: number | null
          previous_value_text: string | null
          reason: string
          source: string | null
          unit: string | null
        }
        Insert: {
          analyst_id: string
          assumption_id: string
          category: string
          confidence?: number | null
          created_at?: string
          evidence_id?: string | null
          id?: string
          name: string
          new_value_numeric?: number | null
          new_value_text?: string | null
          previous_value_numeric?: number | null
          previous_value_text?: string | null
          reason: string
          source?: string | null
          unit?: string | null
        }
        Update: {
          analyst_id?: string
          assumption_id?: string
          category?: string
          confidence?: number | null
          created_at?: string
          evidence_id?: string | null
          id?: string
          name?: string
          new_value_numeric?: number | null
          new_value_text?: string | null
          previous_value_numeric?: number | null
          previous_value_text?: string | null
          reason?: string
          source?: string | null
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analyst_assumption_versions_analyst_id_fkey"
            columns: ["analyst_id"]
            isOneToOne: false
            referencedRelation: "analysts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analyst_assumption_versions_assumption_id_fkey"
            columns: ["assumption_id"]
            isOneToOne: false
            referencedRelation: "analyst_assumptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analyst_assumption_versions_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
        ]
      }
      analyst_assumptions: {
        Row: {
          analyst_id: string
          category: string
          confidence: number | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          source: string | null
          unit: string | null
          updated_at: string
          value_numeric: number | null
          value_text: string | null
        }
        Insert: {
          analyst_id: string
          category?: string
          confidence?: number | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          source?: string | null
          unit?: string | null
          updated_at?: string
          value_numeric?: number | null
          value_text?: string | null
        }
        Update: {
          analyst_id?: string
          category?: string
          confidence?: number | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          source?: string | null
          unit?: string | null
          updated_at?: string
          value_numeric?: number | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analyst_assumptions_analyst_id_fkey"
            columns: ["analyst_id"]
            isOneToOne: false
            referencedRelation: "analysts"
            referencedColumns: ["id"]
          },
        ]
      }
      analyst_evidence: {
        Row: {
          analyst_id: string
          classification: string | null
          created_at: string
          evidence_id: string
          id: string
          relevance_score: number | null
        }
        Insert: {
          analyst_id: string
          classification?: string | null
          created_at?: string
          evidence_id: string
          id?: string
          relevance_score?: number | null
        }
        Update: {
          analyst_id?: string
          classification?: string | null
          created_at?: string
          evidence_id?: string
          id?: string
          relevance_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "analyst_evidence_analyst_id_fkey"
            columns: ["analyst_id"]
            isOneToOne: false
            referencedRelation: "analysts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analyst_evidence_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
        ]
      }
      analyst_jobs: {
        Row: {
          analyst_id: string
          attempts: number
          cancel_reason: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          evidence_id: string | null
          id: string
          job_reason: string | null
          max_attempts: number
          priority: number
          scheduled_for: string
          started_at: string | null
          status: string
          trigger_type: string
          updated_at: string
        }
        Insert: {
          analyst_id: string
          attempts?: number
          cancel_reason?: string | null
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          evidence_id?: string | null
          id?: string
          job_reason?: string | null
          max_attempts?: number
          priority?: number
          scheduled_for?: string
          started_at?: string | null
          status?: string
          trigger_type: string
          updated_at?: string
        }
        Update: {
          analyst_id?: string
          attempts?: number
          cancel_reason?: string | null
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          evidence_id?: string | null
          id?: string
          job_reason?: string | null
          max_attempts?: number
          priority?: number
          scheduled_for?: string
          started_at?: string | null
          status?: string
          trigger_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "analyst_jobs_analyst_id_fkey"
            columns: ["analyst_id"]
            isOneToOne: false
            referencedRelation: "analysts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analyst_jobs_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
        ]
      }
      analyst_runs: {
        Row: {
          analyst_id: string
          completed_at: string | null
          created_at: string
          error_message: string | null
          evidence_id: string | null
          id: string
          input_tokens: number | null
          job_id: string
          latency_ms: number | null
          model: string | null
          output_tokens: number | null
          provider: string | null
          response_id: string | null
          result_json: Json | null
          started_at: string
          status: string
        }
        Insert: {
          analyst_id: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          evidence_id?: string | null
          id?: string
          input_tokens?: number | null
          job_id: string
          latency_ms?: number | null
          model?: string | null
          output_tokens?: number | null
          provider?: string | null
          response_id?: string | null
          result_json?: Json | null
          started_at?: string
          status: string
        }
        Update: {
          analyst_id?: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          evidence_id?: string | null
          id?: string
          input_tokens?: number | null
          job_id?: string
          latency_ms?: number | null
          model?: string | null
          output_tokens?: number | null
          provider?: string | null
          response_id?: string | null
          result_json?: Json | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "analyst_runs_analyst_id_fkey"
            columns: ["analyst_id"]
            isOneToOne: false
            referencedRelation: "analysts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analyst_runs_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analyst_runs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "analyst_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      analyst_slots: {
        Row: {
          active: boolean
          allocated_slots: number
          created_at: string
          id: string
          plan_name: string
          updated_at: string
          used_slots: number
          user_id: string
        }
        Insert: {
          active?: boolean
          allocated_slots?: number
          created_at?: string
          id?: string
          plan_name?: string
          updated_at?: string
          used_slots?: number
          user_id: string
        }
        Update: {
          active?: boolean
          allocated_slots?: number
          created_at?: string
          id?: string
          plan_name?: string
          updated_at?: string
          used_slots?: number
          user_id?: string
        }
        Relationships: []
      }
      analyst_state: {
        Row: {
          analyst_id: string
          confidence: number
          created_at: string
          current_fair_value: number | null
          current_thesis: string | null
          id: string
          last_processed_at: string | null
          last_processed_evidence_id: string | null
          previous_fair_value: number | null
          processing_status: string
          status: string
          updated_at: string
        }
        Insert: {
          analyst_id: string
          confidence?: number
          created_at?: string
          current_fair_value?: number | null
          current_thesis?: string | null
          id?: string
          last_processed_at?: string | null
          last_processed_evidence_id?: string | null
          previous_fair_value?: number | null
          processing_status?: string
          status?: string
          updated_at?: string
        }
        Update: {
          analyst_id?: string
          confidence?: number
          created_at?: string
          current_fair_value?: number | null
          current_thesis?: string | null
          id?: string
          last_processed_at?: string | null
          last_processed_evidence_id?: string | null
          previous_fair_value?: number | null
          processing_status?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "analyst_state_analyst_id_fkey"
            columns: ["analyst_id"]
            isOneToOne: false
            referencedRelation: "analysts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analyst_state_last_processed_evidence_id_fkey"
            columns: ["last_processed_evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
        ]
      }
      analyst_tickers: {
        Row: {
          analyst_id: string
          company_name: string | null
          created_at: string
          id: string
          is_primary: boolean
          ticker: string
        }
        Insert: {
          analyst_id: string
          company_name?: string | null
          created_at?: string
          id?: string
          is_primary?: boolean
          ticker: string
        }
        Update: {
          analyst_id?: string
          company_name?: string | null
          created_at?: string
          id?: string
          is_primary?: boolean
          ticker?: string
        }
        Relationships: [
          {
            foreignKeyName: "analyst_tickers_analyst_id_fkey"
            columns: ["analyst_id"]
            isOneToOne: false
            referencedRelation: "analysts"
            referencedColumns: ["id"]
          },
        ]
      }
      analysts: {
        Row: {
          company_name: string | null
          confidence: number
          created_at: string
          current_fair_value: number | null
          current_thesis: string | null
          id: string
          is_public: boolean
          last_processed_at: string | null
          name: string
          previous_fair_value: number | null
          status: string
          ticker: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          company_name?: string | null
          confidence?: number
          created_at?: string
          current_fair_value?: number | null
          current_thesis?: string | null
          id?: string
          is_public?: boolean
          last_processed_at?: string | null
          name: string
          previous_fair_value?: number | null
          status?: string
          ticker: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          company_name?: string | null
          confidence?: number
          created_at?: string
          current_fair_value?: number | null
          current_thesis?: string | null
          id?: string
          is_public?: boolean
          last_processed_at?: string | null
          name?: string
          previous_fair_value?: number | null
          status?: string
          ticker?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      decision_events: {
        Row: {
          affected_assumptions: Json
          analyst_id: string
          confidence: number
          created_at: string
          event: string
          evidence: string | null
          id: string
          impact: string | null
          new_value: string | null
          old_value: string | null
          reasoning_summary: string | null
          source: string | null
          source_type: string | null
          timestamp: string
        }
        Insert: {
          affected_assumptions?: Json
          analyst_id: string
          confidence?: number
          created_at?: string
          event: string
          evidence?: string | null
          id?: string
          impact?: string | null
          new_value?: string | null
          old_value?: string | null
          reasoning_summary?: string | null
          source?: string | null
          source_type?: string | null
          timestamp?: string
        }
        Update: {
          affected_assumptions?: Json
          analyst_id?: string
          confidence?: number
          created_at?: string
          event?: string
          evidence?: string | null
          id?: string
          impact?: string | null
          new_value?: string | null
          old_value?: string | null
          reasoning_summary?: string | null
          source?: string | null
          source_type?: string | null
          timestamp?: string
        }
        Relationships: [
          {
            foreignKeyName: "decision_events_analyst_id_fkey"
            columns: ["analyst_id"]
            isOneToOne: false
            referencedRelation: "analysts"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_enrichment: {
        Row: {
          content_status: string
          created_at: string
          document_bytes: number | null
          error_code: string | null
          error_message: string | null
          evidence_id: string
          extracted_at: string | null
          extraction_version: string
          facts_count: number
          id: string
          normalized_summary: string | null
          retrieval_ms: number | null
          sections: Json
          sections_count: number
          source_document_hash: string | null
          structured_facts: Json
          updated_at: string
        }
        Insert: {
          content_status?: string
          created_at?: string
          document_bytes?: number | null
          error_code?: string | null
          error_message?: string | null
          evidence_id: string
          extracted_at?: string | null
          extraction_version: string
          facts_count?: number
          id?: string
          normalized_summary?: string | null
          retrieval_ms?: number | null
          sections?: Json
          sections_count?: number
          source_document_hash?: string | null
          structured_facts?: Json
          updated_at?: string
        }
        Update: {
          content_status?: string
          created_at?: string
          document_bytes?: number | null
          error_code?: string | null
          error_message?: string | null
          evidence_id?: string
          extracted_at?: string | null
          extraction_version?: string
          facts_count?: number
          id?: string
          normalized_summary?: string | null
          retrieval_ms?: number | null
          sections?: Json
          sections_count?: number
          source_document_hash?: string | null
          structured_facts?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "evidence_enrichment_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_ingestion_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          duplicate_count: number
          error_code: string | null
          error_message: string | null
          failed_count: number
          fetched_count: number
          id: string
          new_evidence_count: number
          source_type: string
          started_at: string | null
          status: string
          ticker: string
          updated_at: string
          watermark: Json
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          duplicate_count?: number
          error_code?: string | null
          error_message?: string | null
          failed_count?: number
          fetched_count?: number
          id?: string
          new_evidence_count?: number
          source_type: string
          started_at?: string | null
          status?: string
          ticker: string
          updated_at?: string
          watermark?: Json
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          duplicate_count?: number
          error_code?: string | null
          error_message?: string | null
          failed_count?: number
          fetched_count?: number
          id?: string
          new_evidence_count?: number
          source_type?: string
          started_at?: string | null
          status?: string
          ticker?: string
          updated_at?: string
          watermark?: Json
        }
        Relationships: []
      }
      evidence_items: {
        Row: {
          content_hash: string | null
          created_at: string
          external_id: string | null
          id: string
          published_at: string | null
          raw_metadata: Json
          relevance_classified_at: string | null
          relevance_priority: string
          relevance_reason: string | null
          relevance_score: number
          source_type: string
          source_url: string | null
          summary: string | null
          ticker: string
          title: string
        }
        Insert: {
          content_hash?: string | null
          created_at?: string
          external_id?: string | null
          id?: string
          published_at?: string | null
          raw_metadata?: Json
          relevance_classified_at?: string | null
          relevance_priority?: string
          relevance_reason?: string | null
          relevance_score?: number
          source_type: string
          source_url?: string | null
          summary?: string | null
          ticker: string
          title: string
        }
        Update: {
          content_hash?: string | null
          created_at?: string
          external_id?: string | null
          id?: string
          published_at?: string | null
          raw_metadata?: Json
          relevance_classified_at?: string | null
          relevance_priority?: string
          relevance_reason?: string | null
          relevance_score?: number
          source_type?: string
          source_url?: string | null
          summary?: string | null
          ticker?: string
          title?: string
        }
        Relationships: []
      }
      finviz_analyst_ratings: {
        Row: {
          action: string
          analyst: string
          content_hash: string
          created_at: string
          id: string
          price_target_change: string
          rating_change: string
          rating_date: string
          scraped_at: string
          source_id: string
          ticker: string
        }
        Insert: {
          action?: string
          analyst?: string
          content_hash: string
          created_at?: string
          id?: string
          price_target_change?: string
          rating_change?: string
          rating_date: string
          scraped_at: string
          source_id: string
          ticker: string
        }
        Update: {
          action?: string
          analyst?: string
          content_hash?: string
          created_at?: string
          id?: string
          price_target_change?: string
          rating_change?: string
          rating_date?: string
          scraped_at?: string
          source_id?: string
          ticker?: string
        }
        Relationships: [
          {
            foreignKeyName: "finviz_analyst_ratings_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
        ]
      }
      finviz_insider_trades: {
        Row: {
          content_hash: string
          cost: string
          created_at: string
          form4_display_timestamp: string | null
          id: string
          insider_name: string
          relationship: string
          scraped_at: string
          sec_form4_url: string
          shares: string
          shares_total: string
          source_id: string
          ticker: string
          transaction: string
          transaction_date: string
          value: string
        }
        Insert: {
          content_hash: string
          cost?: string
          created_at?: string
          form4_display_timestamp?: string | null
          id?: string
          insider_name?: string
          relationship?: string
          scraped_at: string
          sec_form4_url?: string
          shares?: string
          shares_total?: string
          source_id: string
          ticker: string
          transaction?: string
          transaction_date: string
          value?: string
        }
        Update: {
          content_hash?: string
          cost?: string
          created_at?: string
          form4_display_timestamp?: string | null
          id?: string
          insider_name?: string
          relationship?: string
          scraped_at?: string
          sec_form4_url?: string
          shares?: string
          shares_total?: string
          source_id?: string
          ticker?: string
          transaction?: string
          transaction_date?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "finviz_insider_trades_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          created_at: string
          email: string
          email_enabled: boolean
          id: string
          insider_trades_enabled: boolean
          news_enabled: boolean
          ratings_enabled: boolean
          sec_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          email_enabled?: boolean
          id?: string
          insider_trades_enabled?: boolean
          news_enabled?: boolean
          ratings_enabled?: boolean
          sec_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          email_enabled?: boolean
          id?: string
          insider_trades_enabled?: boolean
          news_enabled?: boolean
          ratings_enabled?: boolean
          sec_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notification_sent_log: {
        Row: {
          attempts: number
          created_at: string
          error_message: string | null
          event_id: string
          event_type: string
          id: string
          recipient_email: string
          sent_at: string | null
          status: string
          subject: string
          ticker: string
          user_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          error_message?: string | null
          event_id: string
          event_type: string
          id?: string
          recipient_email: string
          sent_at?: string | null
          status?: string
          subject: string
          ticker: string
          user_id: string
        }
        Update: {
          attempts?: number
          created_at?: string
          error_message?: string | null
          event_id?: string
          event_type?: string
          id?: string
          recipient_email?: string
          sent_at?: string | null
          status?: string
          subject?: string
          ticker?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      scraped_items: {
        Row: {
          author: string | null
          content: string | null
          content_hash: string
          created_at: string
          id: string
          item_type: string
          metadata: Json
          published_at: string | null
          scraped_at: string
          source_id: string
          ticker: string | null
          title: string | null
          url: string
        }
        Insert: {
          author?: string | null
          content?: string | null
          content_hash: string
          created_at?: string
          id?: string
          item_type: string
          metadata?: Json
          published_at?: string | null
          scraped_at?: string
          source_id: string
          ticker?: string | null
          title?: string | null
          url: string
        }
        Update: {
          author?: string | null
          content?: string | null
          content_hash?: string
          created_at?: string
          id?: string
          item_type?: string
          metadata?: Json
          published_at?: string | null
          scraped_at?: string
          source_id?: string
          ticker?: string | null
          title?: string | null
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "scraped_items_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
        ]
      }
      sources: {
        Row: {
          enabled: boolean
          id: string
          slug: string
        }
        Insert: {
          enabled?: boolean
          id?: string
          slug: string
        }
        Update: {
          enabled?: boolean
          id?: string
          slug?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          analyst_id: string
          created_at: string
          id: string
          status: string
          user_id: string
        }
        Insert: {
          analyst_id: string
          created_at?: string
          id?: string
          status?: string
          user_id: string
        }
        Update: {
          analyst_id?: string
          created_at?: string
          id?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_analyst_id_fkey"
            columns: ["analyst_id"]
            isOneToOne: false
            referencedRelation: "analysts"
            referencedColumns: ["id"]
          },
        ]
      }
      thesis_versions: {
        Row: {
          analyst_id: string
          assumptions: Json
          base_case: string | null
          bear_case: string | null
          bull_case: string | null
          catalysts: Json
          confidence: number
          created_at: string
          id: string
          risks: Json
          summary: string
          version: number
        }
        Insert: {
          analyst_id: string
          assumptions?: Json
          base_case?: string | null
          bear_case?: string | null
          bull_case?: string | null
          catalysts?: Json
          confidence?: number
          created_at?: string
          id?: string
          risks?: Json
          summary: string
          version: number
        }
        Update: {
          analyst_id?: string
          assumptions?: Json
          base_case?: string | null
          bear_case?: string | null
          bull_case?: string | null
          catalysts?: Json
          confidence?: number
          created_at?: string
          id?: string
          risks?: Json
          summary?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "thesis_versions_analyst_id_fkey"
            columns: ["analyst_id"]
            isOneToOne: false
            referencedRelation: "analysts"
            referencedColumns: ["id"]
          },
        ]
      }
      tracked_stocks: {
        Row: {
          company_name: string | null
          created_at: string
          enabled: boolean
          id: string
          ticker: string
        }
        Insert: {
          company_name?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          ticker: string
        }
        Update: {
          company_name?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          ticker?: string
        }
        Relationships: []
      }
      user_preferences: {
        Row: {
          created_at: string
          preferred_language: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          preferred_language: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          preferred_language?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      valuation_versions: {
        Row: {
          affected_assumptions: Json
          analyst_id: string
          created_at: string
          date: string
          evidence: string | null
          id: string
          new_value: number | null
          old_value: number | null
          reason: string
        }
        Insert: {
          affected_assumptions?: Json
          analyst_id: string
          created_at?: string
          date?: string
          evidence?: string | null
          id?: string
          new_value?: number | null
          old_value?: number | null
          reason: string
        }
        Update: {
          affected_assumptions?: Json
          analyst_id?: string
          created_at?: string
          date?: string
          evidence?: string | null
          id?: string
          new_value?: number | null
          old_value?: number | null
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "valuation_versions_analyst_id_fkey"
            columns: ["analyst_id"]
            isOneToOne: false
            referencedRelation: "analysts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_analyst_job: {
        Args: { p_job_id: string; p_user_id: string }
        Returns: {
          analyst_id: string
          attempts: number
          cancel_reason: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          evidence_id: string | null
          id: string
          job_reason: string | null
          max_attempts: number
          priority: number
          scheduled_for: string
          started_at: string | null
          status: string
          trigger_type: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "analyst_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      complete_analyst_job: {
        Args: {
          p_error_message?: string
          p_job_id: string
          p_model: string
          p_provider: string
          p_result: Json
          p_run_id: string
        }
        Returns: {
          analyst_id: string
          attempts: number
          cancel_reason: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          evidence_id: string | null
          id: string
          job_reason: string | null
          max_attempts: number
          priority: number
          scheduled_for: string
          started_at: string | null
          status: string
          trigger_type: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "analyst_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
