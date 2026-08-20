# Årshjulet – delad Netlify-version 1.4

Den här versionen använder Netlify Functions och Netlify Blobs så att alla som öppnar samma Netlify-adress arbetar med samma aktiviteter, typer, ansvariga och inställningar.

## Publicera

Den rekommenderade vägen är att lägga projektmappen i ett GitHub-arkiv och välja **Add new project → Import an existing project** i Netlify. Netlify läser `netlify.toml`, installerar beroendena och publicerar appen automatiskt.

Alternativt kan projektet publiceras med Netlify CLI:

1. Installera Node.js.
2. Kör `npm install` i projektmappen.
3. Kör `npx netlify login`.
4. Kör `npx netlify init` första gången.
5. Kör `npx netlify deploy --build --prod`.

Vanlig statisk drag-och-släpp-publicering ska inte användas eftersom appen innehåller en serverfunktion.

## Gemensam data och uppdateringar

- Produktionsdatan ligger i den site-övergripande Blob-butiken `arshjulet-shared` och följer därför med mellan nya driftsättningar.
- Varje skrivning använder ETag-kontroll. En äldre flik kan inte skriva över en nyare ändring utan konfliktvarning.
- De senaste 100 versionerna sparas automatiskt som säkerhetskopior.
- Dataformatet har `schemaVersion` och migreras till aktuell struktur när det läses eller sparas.
- Appen kontrollerar var 20:e sekund om någon annan har gjort ändringar.
- Produktionsdriftsättningen använder produktionsdata. Deploy previews och lokal utveckling får automatiskt en separat kopia och kan därför inte skriva över teamets riktiga data.
- Automatiskt skapade upprepningar som infaller på lördag eller söndag flyttas till följande måndag. När användaren själv drar endast ett tillfälle till en helg tillåts placeringen och aktivitetskortet markeras med röd ram.
- Färginställningen styr den stora bakgrunden utanför årshjulet. Årshjulets egen kant förblir neutral.
- Samtidiga ändringar i olika aktiviteter slås samman automatiskt. Om två användare ändrar samma aktivitet visas båda versionerna och användaren väljer vilken som ska behållas.
- En lokal konfliktsäkerhetskopia kan återställas från kugghjulsmenyn.

## Åtkomst

Inget användar- eller behörighetssystem finns i appen. Alla som har länken kan läsa och ändra innehållet. Om åtkomsten behöver begränsas kan Netlifys lösenordsskydd aktiveras för hela projektet.

## Lokal testning

Kör `npm install` och sedan `npm run dev`. Netlify CLI startar både webbsidan, serverfunktionen och en lokal Blob-miljö.
