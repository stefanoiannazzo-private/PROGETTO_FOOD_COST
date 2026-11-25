<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * NUOVO — Assistenza: richieste dei ristoratori (per pagina dell'app) e conversazione con il supporto.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('support_tickets', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->unsignedInteger('number');
            $t->char('company_id', 36);
            $t->char('user_id', 36);
            $t->string('area', 40);
            $t->string('kind', 20); // question | problem | suggestion
            $t->string('subject', 160);
            $t->string('status', 12); // open | answered | closed
            $t->string('contact_phone', 40)->nullable();
            $t->string('page_url', 300)->nullable();
            $t->string('user_agent', 300)->nullable();
            $t->dateTime('created_at', 3);
            $t->dateTime('updated_at', 3);
            $t->dateTime('last_user_at', 3)->nullable();
            $t->dateTime('last_staff_at', 3)->nullable();
            $t->dateTime('user_seen_at', 3)->nullable(); // ultima apertura da parte di chi l'ha scritta
            $t->unique('number');
            $t->index(['company_id', 'updated_at'], 'support_tickets_company_idx');
            $t->index(['status', 'updated_at'], 'support_tickets_status_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('user_id')->references('id')->on('users');
        });

        Schema::create('support_messages', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('ticket_id', 36);
            $t->char('author_id', 36)->nullable();
            $t->boolean('from_staff')->default(false);
            $t->text('body');
            $t->string('attachment_path', 200)->nullable();
            $t->string('attachment_name', 200)->nullable();
            $t->string('attachment_mime', 60)->nullable();
            $t->dateTime('created_at', 3);
            $t->index(['ticket_id', 'created_at'], 'support_messages_ticket_idx');
            $t->foreign('ticket_id')->references('id')->on('support_tickets')->cascadeOnDelete();
            $t->foreign('author_id')->references('id')->on('users')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('support_messages');
        Schema::dropIfExists('support_tickets');
    }
};
