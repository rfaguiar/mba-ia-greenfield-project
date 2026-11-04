import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateVideos1793810772423 implements MigrationInterface {
    name = 'CreateVideos1793810772423'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'error')`);
        await queryRunner.query(`CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel_id" uuid NOT NULL, "title" character varying(100) NOT NULL, "original_filename" character varying(255) NOT NULL, "content_type" character varying(100) NOT NULL, "size_bytes" bigint NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "upload_id" character varying, "duration_seconds" numeric(10,3), "metadata" jsonb, "error_code" character varying(50), "error_message" character varying(255), "processing_started_at" TIMESTAMP, "processing_attempts" integer NOT NULL DEFAULT '0', "processed_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_videos_status_created_at" ON "videos" ("status", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_videos_channel_id" ON "videos" ("channel_id") `);
        await queryRunner.query(`ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_videos_channel_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_videos_status_created_at"`);
        await queryRunner.query(`DROP TABLE "videos"`);
        await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
    }

}
