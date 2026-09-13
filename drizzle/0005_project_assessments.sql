ALTER TABLE "match_lot_review_events" DROP CONSTRAINT "match_lot_review_identity";--> statement-breakpoint
ALTER TABLE "match_lot_review_events" ADD CONSTRAINT "match_lot_review_identity" CHECK ("match_lot_review_events"."sequence" > 0
      AND ("match_lot_review_events"."event"->>'version' IS NOT DISTINCT FROM 'human-lot-match-review-v1'
        OR "match_lot_review_events"."event"->>'version' IS NOT DISTINCT FROM 'human-lot-match-review-v2')
      AND "match_lot_review_events"."event"->>'id' IS NOT DISTINCT FROM "match_lot_review_events"."id"
      AND "match_lot_review_events"."event"->>'matchId' IS NOT DISTINCT FROM "match_lot_review_events"."match_id"
      AND "match_lot_review_events"."event"->>'companyId' IS NOT DISTINCT FROM "match_lot_review_events"."company_id"
      AND "match_lot_review_events"."event"->>'publicationId' IS NOT DISTINCT FROM "match_lot_review_events"."publication_id"
      AND "match_lot_review_events"."event"->>'sequence' IS NOT DISTINCT FROM "match_lot_review_events"."sequence"::text);