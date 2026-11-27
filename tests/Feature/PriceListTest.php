<?php

namespace Tests\Feature;

use App\Services\Imports\PriceList;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Tests\ApiClient;
use Tests\TestCase;

/** NUOVO — listino dei fornitori (data, nome, prezzo, iva, U.M., sconti, fornitore). */
class PriceListTest extends TestCase
{
    private const CSV = [
        'data_scarico,nome,price,iva,U.M.,sconti,fornitore',
        '24/11/2026,OLIO extravergine di oliva pet2x5 V,"59,25",4,N.,5+5,NOVAL SRL',
        '24/11/2026,BRESAOLA PUNTA 1/2 sv,"28,7",10,KG,5+5+5,NOVAL SRL',
        '20/11/2026,BRESAOLA PUNTA 1/2 sv,"27,9",10,KG.,,NOV.AL S.R.L.',
        '23/11/2026,Acqua Ferrarelle eff. nat 50cl Pet,"12,06",22,CF,"-10,00",Cicogna Acque Minerali SnC',
        '24/11/2026,900717 UOVA CAT. A M MEDIE SFUSE X 90,"21,19",10,CT,,MARR SPA',
        '24/11/2026,642725 OLIO EVO CUCINARTE PET 5 L,"5,5",,LT,,MARR SPA',
        '24/11/2026,TOVAGLIETTA CARTA 30X40 500pz,"10,5",22,cf,5+10,NOVAL SRL',
        '3/9/2026,ALBICOCCHE Cat.1,"2,8",4,Kg,,SIAL Ortofrutta di santolo veropalumbo',
        '2/9/2025,ALBICOCCHE,,,,,SIAL-ORTOFRUTTA',
        '24/11/2026,030663 PANNA CUCINA UHT 500 ml,"1,89",,PZ,,MARR SPA',
    ];

    public function test_regole_di_lettura(): void
    {
        $this->assertSame(['5', '5', '5'], PriceList::discounts('5+5+5'));
        $this->assertSame(['10', '10', '5'], PriceList::discounts('-10 %, -10 %, -5 %'));
        $this->assertSame(['17'], PriceList::discounts('-17,00'));
        $this->assertSame(['40.7'], PriceList::discounts('-40,70'));
        $this->assertSame(['5', '5'], PriceList::discounts('5,5'));
        $this->assertSame([], PriceList::discounts('+0%'));
        $this->assertSame('53.473125', PriceList::applyDiscounts('59.25', ['5', '5']));
        $this->assertSame(PriceList::supplierKey('NOVAL SRL'), PriceList::supplierKey('NOV.AL S.R.L.'));
        $this->assertTrue(PriceList::sameSupplier(PriceList::supplierKey('SIAL-ORTOFRUTTA'), PriceList::supplierKey('SIAL Ortofrutta di santolo veropalumbo')));
        $this->assertFalse(PriceList::sameSupplier(PriceList::supplierKey('NUOVA COGEA S.r.l.'), PriceList::supplierKey('NUOVA VITELLI E NATURA SRL')));
        $p = PriceList::pack('KG.', 'PEPERONE ROSSO 500g');
        $this->assertSame(['kg', '1', 'kg'], [$p['mode'], $p['content'], $p['unit']]);
        $p = PriceList::pack('CF', '003823 PHILADELPHIA CLASSICO 62gX8');
        $this->assertSame(['8', 'pz', '0.062'], [$p['content'], $p['unit'], $p['pieceKg']]);
        $p = PriceList::pack('PZ', 'FARINA DI CECI KG 10');
        $this->assertSame(['10', 'kg'], [$p['content'], $p['unit']]);
        $p = PriceList::pack('n', 'RISO SCOTTI CARNAROLI 5X1kg S/V');
        $this->assertSame(['1', 'kg'], [$p['content'], $p['unit']], 'venduto a pezzo: il prezzo è di un pacco');
        $p = PriceList::pack('CT', 'RDB SUP.CIOC.MELANG P48G90');
        $this->assertSame(['48', 'pz', '0.09'], [$p['content'], $p['unit'], $p['pieceKg']]);
        $p = PriceList::pack('CF', 'Coca Cola zero latt 33 cl');
        $this->assertNotNull($p['check'], 'cartone con il formato di una lattina: da controllare');
        $this->assertTrue(PriceList::nonFoodName('TOVAGLIETTA CARTA 30X40 500pz'));
    }

    public function test_anteprima_e_applicazione(): void
    {
        $c = $this->createCompany('Momy');
        $this->addMember($c, $this->createUser('a@momy.test', 'A'), 'admin');
        $a = $this->loginAs('a@momy.test');
        // già caricati in passato (con l'IA): albicocche «a confezione 1 kg», acqua corretta a mano a 24 pz, olio MARR con codice
        $mk = fn (array $x) => $this->ok($a->post('/api/ingredients', [...['category' => 'Altro', 'purchaseUnit' => 'confezione', 'usageUnit' => 'g'], ...$x]))['id'];
        $alb = $mk(['code' => 'ING-0001', 'name' => 'ALBICOCCHE Cat.1', 'category' => 'Frutta', 'supplier' => 'SIAL Ortofrutta di santolo veropalumbo', 'packageContent' => '1', 'packageUnit' => 'kg',
            'initialPrice' => ['packagePrice' => '2.8', 'validFrom' => '2026-09-03']]);
        $acq = $mk(['code' => 'ING-0002', 'name' => 'Acqua Ferrarelle eff. nat 50cl Pet', 'category' => 'Bevande', 'supplier' => 'Cicogna Acque Minerali SnC', 'packageContent' => '24', 'packageUnit' => 'pz',
            'usageUnit' => 'pz', 'unitWeightKg' => '0.5', 'densityKgPerL' => '1', 'initialPrice' => ['packagePrice' => '12.06', 'validFrom' => '2026-11-23']]);
        $oli = $mk(['code' => 'MARR-642725', 'name' => 'Olio evo 5 litri', 'category' => 'Olio', 'supplier' => 'MARR SPA', 'packageContent' => '5', 'packageUnit' => 'l', 'usageUnit' => 'ml']);

        $tmp = tempnam(sys_get_temp_dir(), 'pl');
        file_put_contents($tmp, implode("\r\n", self::CSV));
        $r = $this->ok($a->upload('/api/imports/pricelist/preview', 'pricelist', new UploadedFile($tmp, 'Listino Momy.csv', 'text/csv', null, true)));
        $this->assertSame(1, $r['summary']['skipped']);
        $this->assertSame(8, $r['summary']['products'], 'bresaola NOVAL SRL e NOV.AL S.R.L. sono lo stesso prodotto');
        $this->assertSame(3, $r['summary']['update']);
        $p = collect($r['products'])->keyBy('name');
        $this->assertSame('kg', $p['ALBICOCCHE Cat.1']['mode']);
        $this->assertSame($alb, $p['ALBICOCCHE Cat.1']['existingId']);
        $this->assertSame(['24', 'pz'], [$p['Acqua Ferrarelle eff. nat 50cl Pet']['content'], $p['Acqua Ferrarelle eff. nat 50cl Pet']['unit']], 'formato corretto a mano tenuto');
        $this->assertSame('10.8540', $p['Acqua Ferrarelle eff. nat 50cl Pet']['prices'][0]['net'], '-10,00 = 10%');
        $this->assertSame($oli, $p['Olio evo 5 litri']['existingId'], 'abbinato con il codice articolo MARR');
        $this->assertSame('l', $p['Olio evo 5 litri']['mode']);
        $this->assertCount(2, $p['BRESAOLA PUNTA 1/2 sv']['prices']);
        $this->assertSame('24.6067', $p['BRESAOLA PUNTA 1/2 sv']['prices'][0]['net']);
        $this->assertTrue($p['TOVAGLIETTA CARTA 30X40 500pz']['nonFood']);
        $this->assertSame(['500', 'pz'], [$p['TOVAGLIETTA CARTA 30X40 500pz']['content'], $p['TOVAGLIETTA CARTA 30X40 500pz']['unit']]);
        $this->assertSame(['500', 'ml'], [$p['PANNA CUCINA UHT 500 ml']['content'], $p['PANNA CUCINA UHT 500 ml']['unit']]);
        $this->assertSame('MARR-030663', $p['PANNA CUCINA UHT 500 ml']['code']);
        $this->assertCount(2, $r['suppliers']);

        $body = ['products' => array_map(fn ($x) => [
            'existingId' => $x['existingId'], 'code' => $x['code'], 'name' => $x['name'], 'supplier' => $x['supplier'], 'category' => $x['category'], 'nonFood' => $x['nonFood'],
            'mode' => $x['mode'], 'content' => $x['content'], 'unit' => $x['unit'], 'purchaseUnit' => $x['purchaseUnit'], 'pieceKg' => $x['pieceKg'], 'density' => $x['density'],
            'prices' => array_map(fn ($y) => ['date' => $y['date'], 'net' => $y['net'], 'gross' => $y['gross'], 'discount' => $y['discount'] ?: null], $x['prices']),
        ], $r['products'])];
        $res = $this->ok($a->post('/api/imports/pricelist/apply', $body));
        $this->assertSame([5, 3], [$res['created'], $res['updated']]);
        $this->assertSame(2, $res['pricesUpdated'], 'albicocche e acqua: stesso giorno, prezzo sostituito con il netto');

        $this->assertSame('kg', DB::table('ingredients')->where('id', $alb)->value('purchase_unit'));
        $acqua = $this->ok($a->get("/api/ingredients/{$acq}"));
        $this->assertEqualsWithDelta(10.854 / 24, (float) $acqua['currentPrice']['unitPrice'], 0.0001);
        $olio = $this->ok($a->get("/api/ingredients/{$oli}"));
        $this->assertSame(['1', 'l'], [rtrim(rtrim($olio['packageContent'], '0'), '.'), $olio['packageUnit']]);
        $this->assertEqualsWithDelta(5.5, (float) $olio['currentPrice']['unitPrice'], 0.0001);
        $list = collect($this->ok($a->get('/api/ingredients?pageSize=50'))['data'])->keyBy('name');
        $this->assertSame('NOVAL SRL', $list['BRESAOLA PUNTA 1/2 sv']['supplier']);
        $this->assertTrue($list['TOVAGLIETTA CARTA 30X40 500pz']['nonFood']);
        $this->assertFalse($list['TOVAGLIETTA CARTA 30X40 500pz']['needsWeight']);

        // ricaricare lo stesso listino non crea doppioni
        $tmp = tempnam(sys_get_temp_dir(), 'pl');
        file_put_contents($tmp, implode("\r\n", self::CSV));
        $again = $this->ok($a->upload('/api/imports/pricelist/preview', 'pricelist', new UploadedFile($tmp, 'Listino Momy.csv', 'text/csv', null, true)));
        $this->assertSame(0, $again['summary']['new']);

        // l'operatore senza costi non può
        $this->addMember($c, $this->createUser('o@momy.test', 'O'), 'operator');
        $this->assertSame(403, $this->loginAs('o@momy.test')->post('/api/imports/pricelist/apply', $body)->status);
    }
}
