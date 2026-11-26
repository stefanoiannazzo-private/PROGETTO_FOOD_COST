<?php

namespace Tests\Feature;

use Carbon\Carbon;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** NUOVO — promemoria mensile: dal 10 del mese, prima apertura + 3 successive; «Ho già fatto»; solo a chi può caricare. */
class ReminderTest extends TestCase
{
    private string $company;

    protected function setUp(): void
    {
        parent::setUp();
        $this->company = $this->createCompany('Trattoria');
        $this->addMember($this->company, $this->createUser('admin@r.test', 'Admin'), 'admin');
        $this->addMember($this->company, $this->createUser('op@r.test', 'Op'), 'operator');
        $this->createUser('super@r.test', 'Super', true);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    public function test_dal_10_del_mese_per_quattro_aperture(): void
    {
        $a = $this->loginAs('admin@r.test');
        Carbon::setTestNow('2026-12-09 22:30:00'); // 9 dicembre, 23:30 in Italia
        $this->assertFalse($this->ok($a->get('/api/reminders/current'))['due']);
        Carbon::setTestNow('2026-12-09 23:30:00'); // già 10 dicembre in Italia (00:30)
        $r = $this->ok($a->get('/api/reminders/current'));
        $this->assertSame([true, '2026-12', 'dicembre', 3], [$r['due'], $r['period'], $r['monthLabel'], $r['timesLeft']]);
        foreach ([2, 1, 0] as $left) {
            $this->ok($a->post('/api/reminders/seen', ['period' => '2026-12']));
            $r = $this->ok($a->get('/api/reminders/current'));
            $this->assertSame([true, $left], [$r['due'], $r['timesLeft']]);
        }
        $this->ok($a->post('/api/reminders/seen', ['period' => '2026-12']));
        $this->assertFalse($this->ok($a->get('/api/reminders/current'))['due'], 'dopo 4 volte basta');

        Carbon::setTestNow('2027-01-15 10:00:00'); // mese nuovo: si riparte
        $this->assertTrue($this->ok($a->get('/api/reminders/current'))['due']);
    }

    public function test_ho_gia_fatto_e_stato_dei_caricamenti(): void
    {
        Carbon::setTestNow('2026-12-12 09:00:00');
        DB::table('supplier_invoices')->insert(['id' => (string) \Illuminate\Support\Str::uuid(), 'company_id' => $this->company, 'created_at' => '2026-12-05 10:00:00'] + $this->invoiceDefaults());
        $a = $this->loginAs('admin@r.test');
        $r = $this->ok($a->get('/api/reminders/current'));
        $this->assertSame([1, 0], [$r['status']['invoicesThisMonth'], $r['status']['billsThisMonth']]);
        $this->ok($a->post('/api/reminders/done', ['period' => '2026-12']));
        $this->assertFalse($this->ok($a->get('/api/reminders/current'))['due']);
        $this->assertSame(422, $a->post('/api/reminders/seen', ['period' => '2025-01'])->status);
    }

    public function test_non_a_chi_non_puo_caricare_ne_in_assistenza(): void
    {
        Carbon::setTestNow('2026-12-20 09:00:00');
        $op = $this->loginAs('op@r.test');
        $r = $this->ok($op->get('/api/reminders/current'));
        $this->assertSame([false, false, false], [$r['due'], $r['canInvoices'], $r['canBills']]);

        $s = $this->loginAs('super@r.test');
        $this->ok($s->post('/api/auth/company', ['companyId' => $this->company]));
        $this->assertFalse($this->ok($s->get('/api/reminders/current'))['due']);
        $this->ok($s->post('/api/reminders/seen', ['period' => '2026-12']));
        $this->assertSame(0, DB::table('reminder_views')->count(), 'in «Assisti» non si consuma il promemoria del cliente');
    }

    private function invoiceDefaults(): array
    {
        $cols = DB::getSchemaBuilder()->getColumns('supplier_invoices');
        $out = [];
        foreach ($cols as $c) {
            if (! $c['nullable'] && $c['default'] === null && ! in_array($c['name'], ['id', 'company_id', 'created_at'], true)) {
                $out[$c['name']] = str_contains($c['type_name'], 'int') || str_contains($c['type_name'], 'decimal') ? 0 : (str_contains($c['type_name'], 'date') ? '2026-12-05' : (str_contains($c['type_name'], 'json') ? '[]' : 'x'));
            }
        }

        return $out;
    }
}
