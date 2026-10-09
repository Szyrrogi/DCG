# DCG – karcianka ze znajomymi (wersja online)

Gra przepisana z Unity + Photon na grę w przeglądarce z własnym serwerem Node.js.
Cała logika walki działa na serwerze, więc obaj gracze zawsze widzą to samo – nie ma
rozjazdów jak przy synchronizacji Photonem. Działa na komputerze i telefonie.

## Co jest w środku

- **Konta startowe**: szyrrogi, juli, tofame, olaf, jędrek, massyn – hasło `haslo`
  (każdy zmienia je w zakładce **Profil**). Login nie rozróżnia wielkości liter ani
  polskich znaków (`Jedrek` = `jędrek`).
- **Nowe konta**: na ekranie logowania „Nie masz konta? Załóż nowe” – nazwa, hasło
  i zdjęcie profilowe wybrane z dowolnej karty. Nowe konto startuje jak pozostałe.
  Zdjęcie można później zmienić w Profilu (wszystkie karty + portrety).
- **Panel admina** (zakładka **Admin**, widoczna tylko dla `szyrrogi`): ustawianie
  i dodawanie złota, liczba paczek, reset hasła na `haslo`. Zmiany od razu trafiają do bazy
  i gracz widzi je natychmiast. Więcej adminów: zmienna środowiskowa `ADMINS=szyrrogi,juli`.
- **Nagrody**: wygrana = **+10 złota**. Po pokonaniu **5 różnych graczy** → **+100 złota**
  i lista pokonanych się zeruje (widać ją w zakładce Graj).
- **Paczki** jak w Unity: zwykła 50 zł (5 kart, 1% legenda, 10% rzadka),
  legendarna 500 zł (pierwsza karta zawsze legendarna). Start: 1000 zł, 5 zwykłych + 1 legendarna.
- **Kolekcja i talie**: talia ma 20 kart, zwykłe max 3 kopie, rzadkie/legendarne 1.
  Przycisk „Uzupełnij” sam dobiera karty z kolekcji.
- **Rynek wymiany** (zakładka **Rynek**): wystawiasz ofertę „oddam X, chcę Y” – tylko karty tej
  samej rzadkości. Karta zostaje u Ciebie, dopóki ktoś nie przyjmie oferty (nie da się wystawić
  więcej kopii niż masz). Odwrotne oferty dwóch graczy wymieniają się automatycznie. Gdy karta
  odejdzie z kolekcji, znika też z talii – w talii zostaje **puste miejsce** (np. 19/20), talia
  nie nadaje się do gry, dopóki jej nie uzupełnisz, a gra o tym powiadamia. Przed wymianą
  widać ostrzeżenie, które talie stracą kartę.
- **Wytwarzanie (pył)**: w **Kolekcji** kliknij kartę → *Wytwórz* albo *Rozbij*. Rozbicie daje pył
  (zwykła 5, rzadka 20, legendarna 100), wytworzenie kosztuje 40 / 100 / 400. Przycisk
  „Rozbij nadmiarowe” rozbija kopie ponad limit talii. Karty wystawionej na rynku nie da się rozbić,
  a rozbicie karty z talii zostawia w niej puste miejsce. Admin może ustawić pył graczom.
- **Oprawa**: karty lecą z talii do ręki z obrotem (też u przeciwnika), natarcie jednostek,
  wybuchy przy śmierci, wstrząs przy dużych obrażeniach, baner „TWOJA TURA”, konfetti po wygranej,
  błysk przy legendzie w paczce, pogrubione słowa kluczowe na kartach i dźwięki
  (syntezowane w przeglądarce, bez plików – przycisk 🔊 wycisza).
- **Lobby**: widać kto jest online, wyzywasz gracza, on akceptuje i wybiera talię.
- **Walka**: mana miast (Tczew/Warszawa/Bydgoszcz, raz na turę „+”, koszty 1-1-2-2),
  wszystkie 41 kart i ich efekty z `CardEffects.cs`/`PassiveEffectsManager.cs`.
  Klik na kartę w ręce = zagranie, klik na swoją jednostkę → klik na cel = atak.
  Na telefonie pierwsze stuknięcie pokazuje kartę, drugie ją zagrywa.
- **Mulligan**: na starcie zaczynający widzi 3 karty, a drugi gracz 4 i klika te, które chce wymienić (40 s, potem gra
  rusza sama). Wymienione karty wracają do talii.
- **Odrzucanie**: gdy karta każe odrzucić Twoją kartę (Błażej, Grzesiek, Diss na Szymona), sam
  wybierasz którą – kliknij ją dwa razy. Julka (przeciwnik odrzuca) dalej działa losowo.
- **Agnieszka** wskrzesza losową własną jednostkę, która naprawdę zginęła na planszy (nie odrzuconą
  ani nie tę, która tylko „zniknęła”). Olaf zawsze ma pierwszeństwo.
- **Zuzia**: po zagraniu z ręki tura kończy się automatycznie.
- **Wybór many**: gdy karta ma koszt dowolny i da się go zapłacić na kilka sposobów, pojawia się
  okienko, w którym wybierasz, z których miast wziąć manę (podpowiedź jest już ustawiona – wystarczy „Zagraj”).
- **Prowokacja** (Ramus, Bedoes z Tarczą): dopóki przeciwnik ma jednostkę z Prowokacją, ataki muszą iść w nią.
  Piosenki ją ignorują. **Kayle**: dopóki jest na planszy, Twój bohater nie otrzymuje obrażeń.
- Odrzucone jednostki trafiają na cmentarz jako polegli – Agnieszka może je wskrzesić.
- **Wcześniejsza wypłata bonusu**: przy 3/5 pokonanych możesz wypłacić 30 złota, przy 4/5 – 60 złota
  (przycisk w zakładce Graj). Wypłata resetuje serię.
- **Tryb obserwatora**: przy graczu, który gra, jest przycisk „👀 Oglądaj”. Widzisz wtedy planszę i karty
  w rękach obu graczy; gracze dostają informację, że ktoś ogląda.
- Rozłączenie w trakcie gry nie kończy meczu – wystarczy odświeżyć stronę.
  Jeśli przeciwnik nie wróci przez 60 s, możesz odebrać walkower.

## 🚀 Wdrożenie: GitHub + Render + Neon (serwer działa cały czas, za darmo)

Kod leży na GitHubie, serwer gry na **Render**, a konta/złoto/karty w bazie **Neon**.
Znajomi dostają jeden link i grają w przeglądarce – nikt nic nie pobiera.
Każdy `git push` automatycznie aktualizuje grę.

### Krok 1 – repozytorium na GitHubie (~3 min)

Ten folder jest już gotowym repozytorium git (z pierwszym commitem). Utwórz na GitHubie
**nowe, puste** repo (np. `DCG-online`, bez README) i w tym folderze wpisz:

```
git remote add origin https://github.com/Szyrrogi/DCG-online.git
git push -u origin main
```

> Nie masz gita w konsoli? Użyj **GitHub Desktop**: *File → Add local repository* → wskaż
> ten folder → *Publish repository*. (Nie wrzucaj plików przez przeciąganie na stronę –
> ukryty folder `.github` się wtedy nie wgra.)

Repo najlepiej zostawić **publiczne** – wtedy GitHub Actions (testy i budzik) są bez limitu.

### Krok 2 – baza danych na Neon (~2 min)

1. Załóż konto na [neon.tech](https://neon.tech) (logowanie przez GitHub) → **Create project**,
   region **Europe (Frankfurt)**.
2. Na pulpicie projektu kliknij **Connect** i skopiuj *connection string*
   (zaczyna się od `postgresql://…`).

### Krok 3 – serwer na Render (~5 min)

1. Załóż konto na [render.com](https://render.com) (logowanie przez GitHub).
2. **New → Blueprint** → wybierz repo `DCG-online`. Render przeczyta plik `render.yaml`.
3. Poprosi o wartość `DATABASE_URL` – wklej connection string z Neon → **Apply**.
4. Po 2–3 minutach gra działa pod adresem w stylu `https://dcg-xxxx.onrender.com`.
   Ten link wysyłasz znajomym.

### Krok 4 – „zawsze włączony” (~1 min)

Darmowy Render usypia serwer po 15 min bez ruchu. Gra ma na to dwa zabezpieczenia:

- **Serwer sam się budzi** – co 10 min odwiedza własny adres (Render podaje go automatycznie,
  nic nie trzeba ustawiać).
- **Zapasowy budzik na GitHubie** – w repo wejdź w *Settings → Secrets and variables →
  Actions → zakładka Variables → New repository variable*: nazwa `APP_URL`,
  wartość = adres gry z Render (bez `/` na końcu). Od teraz GitHub co ~10 min sprawdza
  `/health` (zakładka **Actions → Keepalive**).

Darmowy plan Render daje 750 godzin miesięcznie, a miesiąc ma ich ~744 – jeden serwer
działający non stop się mieści. GitHub wyłącza zaplanowane akcje po 60 dniach bez żadnego
commita – wtedy wystarczy kliknąć „Enable workflow” w zakładce Actions (a serwer i tak
budzi się sam).

### Co gdzie zmieniać później

- **Nowa wersja gry**: zmieniasz pliki → `git commit` → `git push` → Render sam wdraża
  (przed każdym wdrożeniem dane są zapisywane, nic nie ginie).
- **Złoto graczy**: zakładka **Admin** w grze (konto `szyrrogi`).
- **Kolejni admini**: w Render → serwis → *Environment* → `ADMINS` = `szyrrogi,juli`.
- **Logi serwera**: Render → serwis → *Logs*. Jeśli zobaczysz „brak DATABASE_URL”,
  baza nie jest podpięta i dane zniknęłyby przy restarcie.

## Uruchomienie u siebie (do testów)

1. Zainstaluj [Node.js](https://nodejs.org) (wersja 20 lub nowsza).
2. W folderze gry: `npm install`, potem `npm start`.
3. Otwórz `http://localhost:3000`. Dane zapisują się wtedy w `data/db.json`.

## Testy

```
npm test            # silnik walki: efekty kart + 5000 losowych gier
npm run test:all    # + rynek wymiany + wytwarzanie + serwer (konta, admin, paczki, mecze, nagrody)
```
Na GitHubie testy uruchamiają się same przy każdym pushu (zakładka **Actions → Testy**).

## Grafiki nowych kart

Nowe karty mają na razie zastępcze obrazki. Podmień je własnymi (najlepiej ok. 360×300 px), zapisując
pod dokładnie tymi nazwami w `public/img/art/`:

| Karta | Plik |
|---|---|
| :pp | `pp.png` |
| Ramus | `Ramus.png` |
| Bedoes z Tarczą | `Bedoes_z_Tarcza.png` |
| Kayle | `Kayle.png` |

Jeśli grafika jest w innym formacie (np. `.jpg`), zmień też pole `art` tej karty w `server/cards.json`.

## Dodawanie nowych kart

Karty są w `server/cards.json` (pole `"hiddenDeath": true` ukrywa znikanie po `turnsUntilDeath` turach), obrazki w `public/img/art/`. Dodaj wpis (wzoruj się na
istniejących) i obrazek. Pola: `cost` (T=Tczew, W=Warszawa, B=Bydgoszcz, D=dowolna),
`rarity` 1/2/3, `type` unit/spell, `effect` – nazwa efektu z `server/engine.js`
(funkcja `runEffect`), `passive` – efekt pasywny.

## Zmiany względem wersji z Unity

Poprawione rzeczy, które w Unity nie działały albo były niezgodne z opisem karty:

- **Lian** naprawdę atakuje 2 razy na turę, **Jeżyk** dobiera Julii lub Jędrka.
- **Ola z kajaków** znika po 3 turach (widać licznik ⏳).
- **Gustav** ma ukrytą zdolność: też znika po 3 turach, ale nie ma tego w opisie,
  nie pokazuje licznika i klienci gry nie dostają tej informacji z serwera.
- **Jędrek**: dopóki jest na planszy, odrzucone jednostki trafiają na planszę (jak w opisie).
- **Jestem zmęczony za bardzo** niszczy *wybraną* wrogą jednostkę (wcześniej losową).
- **Olaf** ma podwójny atak przez cały czas, gdy Agnieszka jest na planszy.
- Szarża (`hasCharge`) działa dla każdej karty, nie tylko przez efekt Błażeja.
- Dodane limity: 10 kart w ręce, 7 jednostek na planszy, zmęczenie przy pustej talii
  (żeby gra zawsze się kończyła).

## Struktura

```
server/index.js    serwer: konta, złoto, paczki, talie, lobby, WebSocket
server/engine.js   silnik walki (zasady i efekty kart)
server/store.js    zapis danych: plik JSON albo Postgres (DATABASE_URL)
server/cards.json  41 kart wyciągniętych z Assets/Resources/Cards
public/            gra w przeglądarce (HTML/CSS/JS + grafiki z projektu)
test/              testy
render.yaml        konfiguracja serwera na Render
.github/workflows  testy przy pushu + zapasowy budzik serwera
```
