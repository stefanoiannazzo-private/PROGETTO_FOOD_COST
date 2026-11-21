<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Mail;

/**
 * Invio email (port di services/mailer.ts).
 * - Con MAIL_MAILER=smtp (produzione, es. smtps.aruba.it:465) i messaggi partono dal server di posta.
 * - Altrimenti sono scritti in storage/app/outbox (sviluppo locale), mai inviati.
 */
final class Mailer
{
    public static function configured(): bool
    {
        return config('mail.default') === 'smtp' && (string) config('mail.mailers.smtp.host') !== '';
    }

    /** @return 'sent'|'outbox' */
    public static function send(string $to, string $subject, string $body): string
    {
        if (self::configured()) {
            Mail::raw($body, function ($m) use ($to, $subject) {
                $m->to($to)->subject($subject);
            });

            return 'sent';
        }
        $dir = storage_path('app/outbox');
        if (! is_dir($dir)) {
            mkdir($dir, 0700, true);
        }
        $stamp = str_replace([':', '.'], '-', gmdate('Y-m-d\TH:i:s').'.'.substr((string) microtime(), 2, 3).'Z');
        $file = $dir.'/'.$stamp.'-'.preg_replace('/[^a-z0-9@.]/i', '_', $to).'.eml';
        file_put_contents($file, "To: {$to}\nSubject: {$subject}\nContent-Type: text/plain; charset=utf-8\n\n{$body}\n");
        @chmod($file, 0600);

        return 'outbox';
    }
}
