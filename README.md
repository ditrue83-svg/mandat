# Mandat Radar

Beta per micro e piccole ditte ticinesi: Next.js/TypeScript, PostgreSQL/Drizzle, Better Auth con OTP email, worker pg-boss e AI Infomaniak.

## Anteprima locale

Richiede Node.js 22.12 o superiore (`nvm use` per la versione prevista).

```sh
npm ci
```

Creare `.env.local` con:

```dotenv
APP_MODE=demo
APP_URL=http://127.0.0.1:3000
NEXT_TELEMETRY_DISABLED=1
```

```sh
npm run dev
```

Aprire `http://127.0.0.1:3000`. I bandi e la ditta sono esempi inventati, segnalati in ogni schermata. Salvataggi, esclusioni e preferenze della demo restano nel browser. La demo non invia email, non chiama l’AI e non accede al database.

Percorsi: Radar, salvati, profilo, notifiche, scheda bando, accesso su invito, fonti e area fondatore. L’area fondatore dimostrativa non effettua mutazioni reali.

## Modalità reale

Il backend supporta PostgreSQL locale e Supabase nella regione specifica Zurigo (`eu-central-2`). Supabase gestisce il database; sito Next.js e worker richiedono un host separato. L’accesso usa Better Auth e SQL dal server: non servono chiavi Supabase nel browser.

`npm run setup:init` prepara `.env.production.local` con segreti casuali e permessi 0600, senza sovrascrivere file esistenti. `npm run setup:supabase` predispone la variante gestita. `npm run setup:check -- --env .env.production.local` verifica la configurazione senza collegarsi ai servizi. Aggiungere `--connections` solo dopo le migrazioni, per controllare PostgreSQL, autenticazione SMTP e disponibilità del modello senza inviare email o generare contenuti AI. Questi file di configurazione sono esclusi da Git.

Per inserire la password Supabase senza includerla nella cronologia del terminale, preparare `DATABASE_URL` con i parametri del proprio progetto e password `CHANGE_ME`. Salvare la password in un file temporaneo locale sotto `.data/`, con permessi 0600, quindi eseguire `npm run setup:database-password -- --env .env.production.local --password-file .data/setup/supabase-password.txt`. Il comando codifica i caratteri riservati, conserva gli altri valori della configurazione e rimuove il file temporaneo dopo il salvataggio. Non sovrascrive connessioni già configurate, non mostra segreti e non esegue connessioni di rete.

I passi seguenti descrivono l’esecuzione locale: i comandi npm leggono `.env.local`, che deve essere configurato in modalità reale. Per Docker e per il file separato `.env.production.local` vedere la sezione Distribuzione.

1. Copiare `.env.example` in `.env.local`, compilare le variabili e impostare `APP_MODE=live`.
2. Per Supabase, usare un progetto dedicato a Zurigo, disabilitare Data API ed esposizione automatica, impostare `DATABASE_PROVIDER=supabase`, `SUPABASE_PROJECT_REF` e `DATABASE_URL`. Copiare da Connect la connessione **Session pooler, porta 5432**, senza parametri URI; codificare la password per URL. Il codice impone TLS verificato; se richiesta, impostare `DATABASE_SSL_CA_BASE64` con il certificato pubblico PEM del progetto in base64. In alternativa, soltanto per sviluppo locale: `docker compose -f compose.dev.yml up -d`, con `DATABASE_PROVIDER=local` e `DATABASE_URL=postgresql://mandat:local-development-only@127.0.0.1:5432/mandat`.
3. Applicare le migrazioni: `npm run db:migrate`.
4. Impostare `FOUNDER_EMAIL` e creare l’account: `npm run db:seed`. Il comando è idempotente e non promuove utenti esistenti.
5. Avviare web e worker in processi distinti: `npm run dev` e `npm run worker`.
6. Accedere come fondatore, invitare le ditte e controllare i bandi nell’area fondatore.

`APP_URL` deve corrispondere esattamente all’origine usata nel browser. Gli inviti scadono dopo 14 giorni finché non accettati. I codici scadono dopo 10 minuti, sono memorizzati come hash e ammettono al massimo tre tentativi. La revoca chiude le sessioni e annulla gli invii pendenti.

## Fonti, AI e notifiche

- `npm run sources:probe`: controllo read-only degli ultimi 90 giorni, con report in `artifacts/source-probe.json`. I conteggi per settore sono indicativi, basati solo sui titoli.
- simap: ricerca nel cantone TI più ricerca testuale “Ticino”, dettaglio pubblico, versioni, embargo ore 08:00 Europe/Zurich. I documenti autenticati rimangono sul portale originale.
- Foglio TI: API XML `kabti`, rubrica `OB-TI`. Distribuzione ai clienti e ingestione del worker disabilitate finché `FOGLIO_REUSE_CONFIRMED=true`. Il probe può leggere i metadati pubblici prima dell’attivazione.
- PDF pubblici del Foglio: estrazione del testo e riferimenti di pagina, con revisione per scansioni o file non elaborabili. Nessun accesso a documenti riservati.
- Dati mancanti o incerti richiedono revisione. Non si deduce la scadenza dall’expirationDate del Foglio, né l’importo dal costo dei documenti. Tipi sconosciuti non diventano automaticamente bandi aperti.
- Client AI configurabile tramite endpoint/modello. Default: Infomaniak CH; nessun ripiego automatico su altri paesi. Senza chiave o tariffe correnti non parte alcuna chiamata.
- Budget AI CHF 40/mese: prenotazione conservativa in transazione prima della richiesta; tentativi incerti mantengono la riserva. I prompt non vengono scritti nei log. Le citazioni devono comparire nel testo originale.
- Riepilogo dalle 09:00 soltanto con novità, fonti aggiornate e approvazioni. Esito SMTP incerto: riconciliazione manuale, senza reinvio alla cieca. “Inviata” significa accettata dal server SMTP, non consegna garantita nella casella.
- Riepiloghi annullati prima dell’invio ricalcolabili lo stesso giorno. Il recupero periodico dello storico accoda rettifiche perse durante un’interruzione o arrivate prima di una conferma SMTP tardiva. Rettifiche discordanti restano sospese; “Archivia senza reinviare” è una scelta esplicita del fondatore che l’automazione non annulla.

## Controlli

```sh
npm run typecheck
npm test
npm run build
```

I test di integrazione usano PGlite, PostgreSQL incorporato, applicando le migrazioni reali. Verificano OTP/scadenza/revoca, isolamento fra ditte, feedback, versioni, approvazioni e outbox email. Non sostituiscono il collaudo sui servizi effettivi.

Il test della coda riapre anche il database salvato su disco e verifica che il lavoro rimanga eseguibile. I controlli Supabase verificano TLS, pool, regione, RLS e revoca dei privilegi client. GitHub Actions esegue TypeScript, test e build senza credenziali di produzione.

## Distribuzione

Sono inclusi Dockerfile, Compose, Caddy e script per backup cifrati Restic. Sul server usare `.env` con permessi 0600. Per Supabase impostare `COMPOSE_FILE=compose.supabase.yml`: è una variante autonoma, da non unire a `compose.yml`. Avvio con `docker compose up -d --build`; la migrazione deve riuscire prima di web e worker.

Drizzle gestisce le migrazioni in `drizzle/`. Il collegamento GitHub di Supabase non le applica automaticamente. Per una migrazione esplicita con la configurazione protetta locale:

```sh
node --env-file=.env.production.local --import tsx scripts/migrate.ts
```

`infra/backup.sh` e `infra/restore-check.sh` richiedono Docker, Restic e le variabili di produzione esportate nel processo. La variante Supabase salva gli schemi Mandat `public`, `drizzle` e `pgboss`; il ripristino di prova usa un container isolato. `DATABASE_CLIENT_IMAGE` deve usare una versione PostgreSQL almeno pari a quella del server. Prima dell’uso con ditte reali occorrono un collaudo dei servizi, un ripristino completo, verifica del recapito email e revisione della qualità degli alert.
