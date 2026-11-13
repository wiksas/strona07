# Trąbka Jam

Aplikacja do nauki improwizacji jazzowej na trąbce. Działa w całości w przeglądarce, bez serwera.

1. **Utwór.** Wklej link YouTube i kliknij „Naucz się utworu”: przeglądarka nagrywa dźwięk karty podczas gry filmu (Chrome lub Edge na komputerze). Alternatywy: plik audio albo ręcznie wpisane akordy.
2. **Analiza** (`js/analysis.js`, w Web Workerze): tempo, tonacja (profile Krumhansla-Schmuckera), akordy (chromagram + Viterbi), długość formy.
3. **Solo** (`js/improv.js`): generator linii bebopowej do rozpoznanych akordów. Akompaniament: `js/backing.js`.
4. **Dźwięk**: nagrane próbki trąbki, kontrabasu i fortepianu (`samples/`, FluidR3_GM, CC BY 3.0) odtwarzane przez Web Audio z pogłosem; syntezator jest zapasem, gdy próbki się nie wczytają. Strój: wysokość `f = A4 · 2^((n − 69) / 12)`, A4 = 440 Hz (do zmiany). Częstotliwość bieżącej nuty jest w panelu na dole.
5. **Nuty**: pięciolinia SVG (znaki Bravura), zapis dla trąbki B albo brzmienie.

Ograniczenia: YouTube nie udostępnia ścieżki audio, więc słuchanie wymaga udostępnienia karty. Aplikacja rozpoznaje akordy i tempo, nie melodię; solo jest generowane do akordów.

Lokalnie: `python -m http.server`, potem http://localhost:8000.

Czcionki Barlow i Bravura: SIL OFL 1.1 (`licenses/`).
