<?php

namespace Tests\Feature;

use Tests\TestCase;

/** NUOVO — mensilità pagate e mensilità della voce extra: costo annuo ÷ 12 ÷ ore produttive. */
class EmployeeMonthsTest extends TestCase
{
    public function test_costo_orario_con_mensilita(): void
    {
        $c = $this->createCompany('Trattoria Mensilità');
        $this->addMember($c, $this->createUser('a@mens.test', 'A'), 'admin');
        $a = $this->loginAs('a@mens.test');
        $cost = fn (array $x) => ['validFrom' => '2026-01-01', 'grossMonthly' => '2700', 'contributionsMode' => 'none', 'productiveHours' => '160', ...$x];

        // 12 mensilità, extra 200 su 12: come l'originale → 2900 €/mese, 18,125 €/h
        $r = $this->ok($a->post('/api/employees/cost-preview', $cost(['extraMonthly' => '200', 'monthsPaid' => 12, 'extraMonths' => 12])));
        $this->assertSame(['2900', '34800', '18.125'], [$r['companyMonthly'], $r['annualCost'], $r['companyHourly']]);

        // 14 mensilità, extra 200 su 12 mesi, altri costi 50 €/mese:
        // 2700 × 14 + 200 × 12 = 40.200 → 3350 €/mese + 50 = 3400 €/mese → 40.800 €/anno → 21,25 €/h
        $r = $this->ok($a->post('/api/employees/cost-preview', $cost(['extraMonthly' => '200', 'monthsPaid' => 14, 'extraMonths' => 12, 'otherMonthlyCosts' => '50'])));
        $this->assertSame(['3400', '40800', '21.25'], [$r['companyMonthly'], $r['annualCost'], $r['companyHourly']]);

        // la voce extra non può superare le mensilità
        $bad = $a->post('/api/employees/cost-preview', $cost(['extraMonthly' => '200', 'monthsPaid' => 13, 'extraMonths' => 14]));
        $this->assertSame(422, $bad->status);

        // salvataggio e lettura: il costo entra nel dettaglio e nelle ricette
        $e = $this->ok($a->post('/api/employees', ['firstName' => 'Mario', 'lastName' => 'Rossi', 'firstCost' => $cost(['monthsPaid' => 13])]))['id'];
        $d = $this->ok($a->get("/api/employees/{$e}"));
        $this->assertSame([13, null], [$d['costs'][0]['monthsPaid'], $d['costs'][0]['extraMonths']]);
        $this->assertSame('2925', $d['costs'][0]['companyMonthly']); // 2700 × 13 ÷ 12
    }
}
