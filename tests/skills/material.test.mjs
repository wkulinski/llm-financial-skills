import {describe, expect, it} from 'vitest';
import {extractMainContent} from '../../.agents/skills/bank-market-scan/tools/lib/main-content.mjs';

describe('main content extraction', () => {
    it('keeps product content while removing navigation and footer boilerplate', () => {
        const result = extractMainContent(`
            <html><body>
                <nav><a href="/kredyty">Kredyty</a><a href="/kontakt">Kontakt</a></nav>
                <main class="site-main">
                    <h1>Kredyt mieszkaniowy</h1>
                    <p>Oferta obejmuje spłatę kredytu mieszkaniowego zaciągniętego w innym banku.</p>
                    <p>Oprocentowanie zmienne lub okresowo stałe.</p>
                    <p>Produkt jest przeznaczony na zakup domu, mieszkania, remont i przebudowę. Bank opisuje wymagania, zabezpieczenia, okres kredytowania oraz sposób ustalania rat w szczegółowej informacji dla klienta.</p>
                </main>
                <footer>Polityka cookies i dane kontaktowe</footer>
            </body></html>
        `);

        expect(result.extraction.mode).toBe('main_content');
        expect(result.extraction.fallback_used).toBe(false);
        expect(result.text).toContain('spłatę kredytu mieszkaniowego');
        expect(result.text).not.toContain('Polityka cookies');
        expect(result.text).not.toContain('Kontakt');
    });

    it('falls back to cleaned body when a page has no main-content candidate', () => {
        const result = extractMainContent(`
            <html><body>
                <div class="menu">Menu kredytów</div>
                <div class="page-copy">
                    <h1>Kredyt hipoteczny</h1>
                    <p>Oprocentowanie okresowo stałe przez 5 lat.</p>
                </div>
                <div class="cookie-banner">Akceptuję cookies</div>
            </body></html>
        `);

        expect(result.extraction.mode).toBe('cleaned_body');
        expect(result.extraction.fallback_used).toBe(true);
        expect(result.text).toContain('Kredyt hipoteczny');
        expect(result.text).not.toContain('Akceptuję cookies');
    });
});
