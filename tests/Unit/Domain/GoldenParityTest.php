<?php

namespace Tests\Unit\Domain;

use App\Domain\Costing\Dec;
use App\Domain\Costing\DomainError;
use App\Domain\Costing\Graph;
use App\Domain\Costing\NumberFormat;
use App\Domain\Costing\RecipeCostEngine;
use App\Domain\Costing\Serializer;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Parità numerica con il motore TypeScript originale.
 * I file in tests/Fixtures/golden sono generati eseguendo il codice originale (tools/golden/generate.ts):
 * qui si verifica che il motore PHP produca esattamente le stesse stringhe, cifra per cifra.
 */
class GoldenParityTest extends TestCase
{
    private static function load(string $name): array
    {
        return json_decode(file_get_contents(__DIR__.'/../../Fixtures/golden/'.$name.'.json'), true, 512, JSON_THROW_ON_ERROR);
    }

    private static function toDec(mixed $v): mixed
    {
        if (is_array($v) && array_key_exists('$d', $v)) {
            return Dec::of($v['$d']);
        }

        return is_array($v) ? array_map([self::class, 'toDec'], $v) : $v;
    }

    public function test_operazioni_decimali(): void
    {
        $ops = self::load('decimal');
        $this->assertGreaterThan(500, count($ops));
        foreach ($ops as $o) {
            $a = Dec::of($o['a']);
            $b = Dec::of($o['b']);
            $got = ['plus' => $a->plus($b)->toFixed(), 'minus' => $a->minus($b)->toFixed(), 'times' => $a->times($b)->toFixed(), 'div' => $b->isZero() ? null : $a->div($b)->toFixed()];
            if (! $b->isZero()) {
                $got['dp2'] = $a->div($b)->toDecimalPlaces(2)->toFixed();
                $got['dp4'] = $a->div($b)->toDecimalPlaces(4)->toFixed();
            }
            foreach ($got as $k => $v) {
                $this->assertSame($o[$k], $v, "{$k}({$o['a']}, {$o['b']})");
            }
        }
    }

    public function test_numeri_in_formato_italiano(): void
    {
        foreach (self::load('parse') as $p) {
            $this->assertSame($p['out'], NumberFormat::parseItalianNumber($p['input'], $p['mode'])?->toFixed(), "'{$p['input']}' ({$p['mode']})");
        }
    }

    public function test_grafo_cicli_e_dipendenze(): void
    {
        foreach (self::load('graph') as $g) {
            $this->assertSame($g['cycle'], Graph::findCycle($g['edges'], $g['node'], $g['children']));
            $d = Graph::dependentsOf($g['edges'], [$g['node']]);
            sort($d);
            $this->assertSame($g['dependents'], $d);
            $e = Graph::descendantsOf($g['edges'], [$g['node']]);
            sort($e);
            $this->assertSame($g['descendants'], $e);
        }
    }

    public static function engineCases(): iterable
    {
        foreach (self::load('engine') as $i => $case) {
            yield "contesto {$i}" => [$i];
        }
    }

    #[DataProvider('engineCases')]
    public function test_motore_ricette(int $i): void
    {
        static $cases = null;
        $cases ??= self::load('engine');
        $case = $cases[$i];
        $ctx = self::toDec($case['context']);
        foreach ($case['results'] as $id => $expected) {
            try {
                $got = json_decode(json_encode(Serializer::serialize(RecipeCostEngine::valueRecipe($ctx, (string) $id))), true);
            } catch (DomainError $e) {
                $got = ['error' => $e->errorCode, 'message' => $e->getMessage()];
            }
            $this->assertSame(self::canon($expected), self::canon($got), "ricetta {$id}");
        }
    }

    /** Ordina le chiavi degli oggetti (l'ordine delle chiavi JSON non è significativo, quello delle liste sì). */
    private static function canon(mixed $v): mixed
    {
        if (! is_array($v)) {
            return $v;
        }
        $v = array_map([self::class, 'canon'], $v);
        if (! array_is_list($v)) {
            ksort($v);
        }

        return $v;
    }
}
