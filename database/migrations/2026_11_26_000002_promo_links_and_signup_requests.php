<?php

use App\Services\Promoters;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * NUOVO — (1) chiave «tollerante» del codice promo: maiuscole/minuscole, spazi, trattini e lettere
 * scambiate con cifre (O/0, I/L/1) portano allo stesso codice; (2) richieste di attivazione dal link del promotore.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('promoters', function (Blueprint $t) {
            $t->string('code_key', 24)->nullable()->after('code');
        });
        foreach (DB::table('promoters')->get(['id', 'code']) as $p) {
            DB::table('promoters')->where('id', $p->id)->update(['code_key' => Promoters::key($p->code)]);
        }
        Schema::table('promoters', function (Blueprint $t) {
            $t->unique('code_key');
        });

        Schema::create('signup_requests', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->string('business_name', 160);
            $t->string('contact_name', 120);
            $t->string('email', 254);
            $t->string('phone', 40)->nullable();
            $t->string('city', 80)->nullable();
            $t->text('message')->nullable();
            $t->char('promoter_id', 36)->nullable();
            $t->string('promo_code', 24)->nullable();
            $t->string('status', 12)->default('pending'); // pending | approved | rejected
            $t->char('company_id', 36)->nullable();
            $t->dateTime('created_at', 3);
            $t->dateTime('handled_at', 3)->nullable();
            $t->char('handled_by', 36)->nullable();
            $t->index(['status', 'created_at']);
            $t->index('promoter_id');
            $t->index('email');
            $t->foreign('promoter_id')->references('id')->on('promoters')->nullOnDelete();
            $t->foreign('company_id')->references('id')->on('companies')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('signup_requests');
        Schema::table('promoters', function (Blueprint $t) {
            $t->dropUnique(['code_key']);
            $t->dropColumn('code_key');
        });
    }
};
