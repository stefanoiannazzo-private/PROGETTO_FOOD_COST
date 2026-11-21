<?php

declare(strict_types=1);

namespace App\Domain\Costing;

/**
 * Grafo delle dipendenze tra ricette (padre → sottoricette), port di graph.ts.
 * $edges: array<string, list<string>>.
 */
final class Graph
{
    /**
     * Percorso del ciclo che si creerebbe dando a $recipeId i figli $children, oppure null.
     * Il percorso parte e termina con $recipeId.
     *
     * @return list<string>|null
     */
    public static function findCycle(array $edges, string $recipeId, array $children): ?array
    {
        $visited = [];
        $childrenOf = fn (string $id): array => $id === $recipeId ? $children : ($edges[$id] ?? []);
        $dfs = function (string $node, array $path) use (&$dfs, &$visited, $childrenOf, $recipeId): ?array {
            foreach ($childrenOf($node) as $child) {
                if ($child === $recipeId) {
                    return [...$path, $child];
                }
                if (isset($visited[$child])) {
                    continue;
                }
                $visited[$child] = true;
                $found = $dfs($child, [...$path, $child]);
                if ($found) {
                    return $found;
                }
            }

            return null;
        };

        return $dfs($recipeId, [$recipeId]);
    }

    /** Tutte le ricette che dipendono, direttamente o indirettamente, da uno dei nodi indicati. @return list<string> */
    public static function dependentsOf(array $edges, array $targets): array
    {
        $parents = [];
        foreach ($edges as $parent => $kids) {
            foreach ($kids as $k) {
                $parents[$k][] = (string) $parent;
            }
        }
        $result = [];
        $queue = array_values($targets);
        while ($queue) {
            $node = array_shift($queue);
            foreach ($parents[$node] ?? [] as $p) {
                if (! isset($result[$p])) {
                    $result[$p] = true;
                    $queue[] = $p;
                }
            }
        }

        return array_map('strval', array_keys($result));
    }

    /** Chiusura delle sottoricette raggiungibili (incluse le radici). @return list<string> */
    public static function descendantsOf(array $edges, array $roots): array
    {
        $result = [];
        $queue = array_values($roots);
        while ($queue) {
            $node = array_shift($queue);
            if (isset($result[$node])) {
                continue;
            }
            $result[$node] = true;
            foreach ($edges[$node] ?? [] as $c) {
                $queue[] = $c;
            }
        }

        return array_map('strval', array_keys($result));
    }
}
