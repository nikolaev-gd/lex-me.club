# Politica de confidențialitate

**Lex — profesor de engleză pentru YouTube**

Ultima actualizare: 18 iulie 2026

Această versiune în limba română este versiunea autentică a prezentei politici, publicată la [lex-me.club/confidentialitate](https://lex-me.club/confidentialitate), conform art. 12 alin. (1) din Legea nr. 284/2004 privind serviciile societății informaționale, art. 33 alin. (7) din Legea nr. 105/2003 privind protecția consumatorilor și art. 1015 alin. (7) din Codul civil. Textul în limba engleză este o traducere neoficială. În caz de neconcordanță, prevalează versiunea în limba română.

Această pagină explică ce colectează Lex, de ce, unde ajung datele și ce puteți face în această privință. Descrie comportamentul real al codului, nu o variantă idealizată a acestuia. Dacă ceva de aici vă deranjează, apare aici pentru că este adevărat.

## Cine răspunde de datele dumneavoastră

Operatorul datelor dumneavoastră cu caracter personal este:

- **A.I. Ghenadi Nicolaev** (antreprenor individual / individual entrepreneur)
- Statul de stabilire: **Republica Moldova**
- IDNO: **1026023035183**
- Codul TVA: **nu se aplică — nu este înregistrat ca plătitor de TVA**
- Adresa juridică: s. Congaz, str. Pionierii 5, Republica Moldova
- Adresa fizică (de activitate): s. Congaz, str. Pionierii 5, Republica Moldova
- E-mail: **nikolaev.gd@gmail.com**
- Telefon: **+373 60 220 120** (prefixul de țară +373)
- Fax: nu există
- Persoana de contact: Ghenadi Nicolaev
- Site web: https://lex-me.club
- Pagina din Chrome Web Store: https://chromewebstore.google.com/detail/lex/bfdbiphpcnjbofngcnjjdbnolcgaaidl
- Autorizare / licență: potrivit legislației Republicii Moldova, prestarea acestui serviciu nu necesită autorizare și, prin urmare, nu se publică niciun număr de autorizare (art. 12 alin. (1) lit. d) din Legea nr. 284/2004).

Pentru întrebări legate de confidențialitate și pentru asistență, scrieți la **nikolaev.gd@gmail.com** sau sunați la **+373 60 220 120**. Asistența este disponibilă **de luni până vineri, 09:00–18:00 (ora Chișinăului)**, cel puțin cinci zile pe săptămână, iar la e-mailuri răspundem în termen de trei zile lucrătoare.


## Ce este Lex, într-un singur paragraf

Lex este o extensie pentru Chrome. Predarea are loc pe YouTube: Lex ia videoclipul pe care îl urmăriți deja, produce pentru el subtitrări ușor de citit și vă permite să discutați despre acel videoclip cu un profesor de engleză — prin text sau prin voce. Clicul pe un cuvânt este o cale rapidă de a-l întreba pe profesor despre acel cuvânt. Fereastra de chat poate fi deschisă și peste orice pagină pe care o aveți deschisă, acesta fiind singurul motiv pentru care Lex solicită acces la toate site-urile. Lex nu are funcție de descărcare și nu vă oferă niciodată o copie a conținutului video.

## Ce colectează Lex și de ce

### Contul dumneavoastră

Pentru a folosi orice funcție cu plată, trebuie să fiți autentificat. Stocăm adresa dumneavoastră de e-mail și o sesiune de autentificare (token de acces, token de reîmprospătare, data expirării, identificatorul dumneavoastră de utilizator și e-mailul). Parola dumneavoastră nu este niciodată stocată de extensie — este transmisă o singură dată către serviciul (endpoint-ul) de înregistrare sau de autentificare și este gestionată de furnizorul nostru de autentificare.

Scopul: identificarea contului dumneavoastră, păstrarea soldului preplătit, refuzul apelurilor cu plată către modele în lipsa unui cont valabil.

### Încercările de creare a contului

Când cineva creează un cont, înregistrăm adresa IP a încercării, dacă încercarea a reușit, precum și data și ora.

Scopul: limitarea numărului de solicitări într-un interval de timp. Crearea contului este singura funcție accesibilă fără autentificare, deci trebuie protejată împotriva abuzurilor.

Precizare sinceră: aceste înregistrări de adrese IP nu au în prezent **nicio regulă de ștergere automată**. Ele se păstrează până la ștergerea manuală.

### Ce urmăriți

De fiecare dată când activați Lex pe un videoclip, stocăm un instantaneu al acelui videoclip: URL, titlu, descriere, numele canalului, autorul, hashtagurile, durata, dacă este Shorts sau videoclip obișnuit, limba subtitrărilor și versiunea extensiei — împreună cu identificatorul contului dumneavoastră și un identificator anonim de instalare.

Ca să fie clar ce înseamnă acest lucru: **este un istoric al fiecărui videoclip YouTube pe care l-ați urmărit folosind Lex.**

Scopul: această înregistrare este cea care autorizează și tarifează fiecare apel facturat către model — profesorul nu poate răspunde la întrebări despre un videoclip fără să știe despre care videoclip este vorba, iar soldul dumneavoastră nu poate fi debitat corect fără ea. Nu o folosim pentru analize generale de produs, pentru publicitate sau pentru crearea de profiluri.

### Conversațiile dumneavoastră și răspunsurile modelului

Pentru fiecare apel către un model de text, stocăm ce se trimite și ce se primește: mesajul dumneavoastră din chat, contextul clicului pe cuvânt sau întreaga transcriere a subtitrărilor cu marcaje de timp trimisă spre procesare — și răspunsul modelului. Alături de acestea: cuvântul, identificatorul videoclipului, funcția din care a provenit, numărul de tokenuri, costul și duratele.

Scopul: facturarea soldului dumneavoastră preplătit pe server și păstrarea evidenței a ceea ce a fost tarifat.

Stocăm, de asemenea, istoricul conversației pentru fiecare videoclip (fiecare replică, rolul și conținutul textual exact), astfel încât conversația dumneavoastră să vă urmeze de la un dispozitiv la altul.

### Vocea

În modul vocal, sunetul de la microfonul dumneavoastră este captat pe toată durata sesiunii ca un singur fișier WAV mono de 16 kHz și este încărcat în spațiul nostru de stocare. Transcrierea a ceea ce ați spus este, de asemenea, stocată ca text.

Dacă folosiți evaluarea pronunției, se încarcă și înregistrarea încercării dumneavoastră, împreună cu cuvântul-țintă, propoziția din jur, scorurile pentru fiecare fonem și pentru fiecare silabă, scorurile generale de acuratețe/fluență/prozodie, nivelurile estimate CEFR/IELTS/PTE/TOEIC și răspunsul brut al furnizorului de evaluare.

Scopul: fluxul audio live este ceea ce îi permite profesorului să vă audă și să vă răspundă, iar transcrierea replicii dumneavoastră este ceea ce facturăm. Înregistrarea integrală a sesiunii se păstrează ulterior ca evidență a sesiunii, iar înregistrările de pronunție ca istoric al pronunției dumneavoastră. Înregistrările stocate nu sunt necesare pentru a produce răspunsurile profesorului.

### Subtitrările

Stocăm subtitrările procesate ale videoclipurilor pe care le-ați urmărit, astfel încât revenirea la un videoclip să nu declanșeze din nou o etapă de procesare cu plată.

Stocăm, de asemenea, date de diagnostic despre modul în care au fost captate subtitrările — URL-ul și parametrii folosiți, identificatorul videoclipului, limba, rezultatul, mesajele de eroare — **inclusiv conținutul brut al subtitrărilor returnate de YouTube**.

Scopul: subtitrările procesate sunt funcția pe care o vedeți pe ecran. Datele de diagnostic ale captării există pentru a menține funcțională captarea subtitrărilor și pentru a investiga eșecurile.

Precizare sinceră: conținutul brut al subtitrărilor este singurul element cu expirare automată. O sarcină programată rulează zilnic și golește conținutul brut al subtitrărilor mai vechi de 30 de zile. Restul înregistrării de diagnostic se păstrează.

### Banii

Stocăm soldul, starea contului dumneavoastră și fiecare modificare a soldului împreună cu motivul, referința și marcajul de timp aferente. Datele cardului nu fac parte din acestea — a se vedea secțiunea despre plăți.

### Setările

Modelele pe care le alegeți, limba interfeței, sloturile de prompturi și alte setări sunt stocate pentru a fi sincronizate între dispozitive.

### Un identificator anonim de instalare

Fiecare profil de browser primește un identificator aleatoriu la prima instalare a lui Lex. El este scris alături de identificatorul contului dumneavoastră în sesiunile video, în datele de diagnostic ale subtitrărilor și în înregistrările de pronunție.

Precizare sinceră: acest identificator **supraviețuiește deconectării** și nu se schimbă dacă vă autentificați cu un alt cont pe același profil de browser. Aceasta înseamnă că două conturi folosite pe același calculator pot fi legate prin el. Este o rămășiță din perioada de dinaintea obligativității autentificării.

### Ce trebuie să furnizați și ce se întâmplă dacă nu o faceți

Necesare pentru ca serviciul să poată funcționa în principiu — refuzul înseamnă că Lex nu poate fi utilizat:

- **Adresa de e-mail și parola.** Obligatorii din punct de vedere contractual. Fără cont nu există sold, iar orice apel cu plată către model este refuzat.
- **Instantaneul videoclipului și înregistrarea sesiunii.** Obligatorii din punct de vedere contractual. Ele sunt cele care autorizează și tarifează fiecare apel din soldul dumneavoastră.
- **Textul mesajului dumneavoastră și subtitrările videoclipului.** Obligatorii din punct de vedere contractual. Profesorul nu poate răspunde fără ele.

Opționale — refuzul vă costă doar acea singură funcție:

- **Sunetul de la microfon.** Captat doar dacă activați modul vocal sau evaluarea pronunției. Dacă refuzați, chatul text funcționează normal.
- **Propriile dumneavoastră chei API de furnizor.** Doar dacă alegeți să le folosiți; ele rămân în browserul dumneavoastră.

Nu vă cerem să ne furnizați voluntar niciun fel de alte date. Adresa IP se consemnează automat la crearea contului, pentru prevenirea abuzurilor, și nu poate fi refuzată separat de crearea contului.

## Ce rămâne doar în browserul dumneavoastră

O parte din date nu părăsesc niciodată calculatorul dumneavoastră. Ele rămân totuși date despre dumneavoastră, iar regulile magazinului Chrome Web Store ne obligă să le divulgăm, așa că le enumerăm mai jos.

În IndexedDB (baza de date `lex_db`):

- clicurile pe cuvinte — cuvântul, contextul său, titlul și URL-ul videoclipului, promptul folosit și apelurile efectuate către modele
- înregistrările de procesare a subtitrărilor
- un instantaneu, pentru fiecare apel, cu exact ce a fost trimis către modelele de text și ce s-a primit de la ele
- înregistrările vocale — limitate la 200 de clipuri sau 150 MB, cele mai vechi fiind șterse primele
- ultimele 300 de captări brute de subtitrări
- subtitrările procesate pentru ultimele 300 de videoclipuri

În spațiul de stocare al extensiei Chrome:

- sesiunea dumneavoastră de autentificare (tokenuri, identificator de utilizator, e-mail)
- identificatorul anonim de instalare
- istoricul conversației dumneavoastră pentru fiecare videoclip
- modelul activ pentru fiecare videoclip, un cache de pronunție
- dacă folosiți propriile chei API de furnizor, acele chei

Precizare sinceră: clicurile pe cuvinte și instantaneele apelurilor către modele **nu au nicio limită de dimensiune** și cresc nelimitat pe calculatorul dumneavoastră. Restul se curăță singur în funcție de dimensiune, nu de vechime.

Dezinstalarea extensiei șterge și aceste date locale.

## Site-ul web, lex-me.club

Site-ul web folosește doar cookie-uri strict necesare pentru a vă menține autentificat și pentru a finaliza o plată. Nu setează cookie-uri publicitare, nu folosește servicii de analiză ale terților și nu vă urmărește pe alte site-uri, prin urmare nu este necesar un banner de consimțământ. Furnizorul dumneavoastră de plăți poate seta propriile cookie-uri pe pagina sa de plată, conform politicii sale.

Când vizitați lex-me.club, furnizorul nostru de găzduire prelucrează adresa dumneavoastră IP și user-agentul browserului în jurnalele de server, pentru securitate și pentru menținerea în funcțiune a site-ului.

## Terții care primesc datele dumneavoastră

Lex nu poate produce răspunsurile profesorului fără a trimite conținutul dumneavoastră către furnizorii de servicii de inteligență artificială. Aceasta este esența funcționării Lex, iar această secțiune ar trebui citită cu atenție.

### Furnizorii de servicii de inteligență artificială

**OpenAI** — primește mesajele dumneavoastră din chat, contextul clicului pe cuvânt, transcrierile subtitrărilor și prompturile de sistem (retransmise prin serverul nostru). În modul vocal, sunetul de la microfonul dumneavoastră se transmite **direct din browserul dumneavoastră către OpenAI**, nu prin serverul nostru. Este folosit și pentru dictare și pentru transcrierea audio.

**Anthropic** — primește prompturi text și conținutul conversației, retransmise prin serverul nostru.

**Google** — primește identitatea contului dumneavoastră Google dacă alegeți autentificarea prin Google și, prin Gemini, primește prompturi text și conținut prin serverul nostru. În modul vocal Gemini, sunetul de la microfonul dumneavoastră se transmite **direct din browserul dumneavoastră către Google** printr-un WebSocket.

**Groq** — primește sunetul pentru transcriere atunci când un videoclip nu are subtitrări YouTube și Lex trebuie să transcrie el însuși sunetul.

Ce poate face fiecare furnizor cu conținutul pe care îl primește este reglementat de propriile condiții de utilizare a API-ului, publicate de acesta, pe care ar trebui să le citiți direct; nu le reproducem aici, pentru că se schimbă. Nu am semnat încă acorduri de prelucrare a datelor cu acești furnizori și nu am activat opțiunea de nereținere a datelor (zero retention) acolo unde este oferită. Când o vom face, această secțiune va indica acordul și setarea de reținere.

**Poate un om să citească ce scrieți?** Nu la Lex — noi nu vă citim conversațiile. La furnizorii de servicii de inteligență artificială, o persoană vă poate citi conținutul atunci când un sistem automat de detectare a abuzurilor sau de siguranță îl semnalează și cineva analizează semnalarea. Aceasta este o verificare de securitate, nu o îmbunătățire a produsului.

### Evaluarea pronunției

Acolo unde evaluarea pronunției este disponibilă, ea trimite sunetul de la microfonul dumneavoastră către **Microsoft Azure Cognitive Services** (regiunea West Europe), direct din pagină, iar încercarea dumneavoastră înregistrată împreună cu cuvântul sau propoziția-țintă către **SpeechAce**, din procesul de fundal al extensiei.

### Infrastructura

**Supabase** — baza noastră de date, furnizorul de autentificare, spațiul de stocare audio și proxy-ul prin care este retransmis traficul către modele. Găzduiește tot ce este enumerat în secțiunile de mai sus.

**RapidAPI (ytjar) și CDN-ul 123tokyo.xyz** — când un videoclip nu are subtitrări proprii, Lex trebuie să producă subtitrări pornind de la sunet. Identificatorul videoclipului este trimis pentru a obține adresa unui flux audio, iar fluxul este citit de browserul dumneavoastră pentru a fi transcris, ceea ce înseamnă că adresa dumneavoastră IP ajunge la acel CDN. Nimic nu se salvează pe calculatorul dumneavoastră ca fișier media și nimic nu vă este oferit spre păstrare.

**Furnizorul nostru de plăți** — a se vedea secțiunea despre plăți de mai jos.

Nu vindem datele dumneavoastră. Nu le partajăm cu agenți de publicitate, brokeri de date sau revânzători de informații. Nu le folosim pentru publicitate, pentru crearea de profiluri în scop publicitar sau pentru decizii de creditare.

Nu vom divulga datele dumneavoastră niciunui alt terț fără consimțământul dumneavoastră, cu excepțiile prevăzute de lege — la o solicitare legală a unei instituții de stat, a unui organ de drept sau a unei instanțe de judecată, ori atunci când divulgarea este necesară pentru constatarea, exercitarea sau apărarea unui drept în justiție. Dacă primim o asemenea solicitare, vă vom informa, cu excepția cazului în care legea ne interzice acest lucru.

Datele dumneavoastră sunt prelucrate prin mijloace mixte — automatizate și manuale.

**Declarație pentru Chrome Web Store:** utilizarea datelor de către Lex este conformă cu Politica privind datele utilizatorilor din Chrome Web Store, inclusiv cu cerințele privind utilizarea limitată. Datele sunt colectate, utilizate și transmise numai în măsura necesară scopului unic al lui Lex — predarea limbii engleze pe videoclipul YouTube ales de dumneavoastră — și pentru scopuri operaționale conexe, precum facturarea, securitatea și fiabilitatea.

## Plățile

Plățile nu sunt încă disponibile. Când vor fi activate, plata pentru soldul dumneavoastră preplătit va fi gestionată de un furnizor de plăți. **Datele cardului vor fi introduse pe propria pagină securizată a furnizorului de plăți și nu vor ajunge niciodată la noi.** Nu vom vedea și nu vom stoca niciodată numărul cardului, data expirării, codul de securitate sau numele deținătorului cardului. Autentificarea 3-D Secure se aplică plăților cu cardul.

Furnizorul va primi adresa dumneavoastră de e-mail, suma, țara de facturare și adresa IP și va prelucra aceste date în calitate de operator independent, conform politicii sale de confidențialitate, accesibilă printr-un link de pe pagina de plată. Acolo unde furnizorul acționează ca Merchant of Record, el este vânzătorul înregistrat pentru acea tranzacție. Ne va transmite ceea ce ne este necesar pentru a vă credita soldul și pentru a ne ține evidența contabilă. Vom indica pe această pagină numele furnizorului și vom enumera exact ce ne transmite, înainte de încasarea primei plăți.

Livrarea este imediată și electronică: soldul dumneavoastră este disponibil în contul dumneavoastră imediat ce plata este confirmată. Nu există cost de livrare.

Rambursările se fac prin aceeași metodă prin care a fost efectuată plata. Soldul dumneavoastră necheltuit este rambursabil la cerere; soldul deja cheltuit nu este.

Aveți, de asemenea, dreptul legal de retragere dintr-un contract la distanță în termen de 14 zile, conform art. 1059–1060 din Codul civil al Republicii Moldova. Pentru un sold preplătit, acest termen curge din ziua încheierii contractului. Pentru a-l exercita, scrieți la nikolaev.gd@gmail.com — puteți folosi formularul standard de revocare prevăzut în Anexa nr. 6 la Legea nr. 1125/2002, dar nu sunteți obligat. Soldul dumneavoastră necheltuit se rambursează integral, prin aceeași metodă prin care ați plătit.

## Unde sunt stocate datele dumneavoastră

Datele stocate pe server se află într-un singur proiect Supabase găzduit în **AWS eu-central-1 (Frankfurt, Uniunea Europeană)**, pe PostgreSQL.

Înregistrările vocale și cele de pronunție sunt stocate într-un container de stocare **privat**. Nu este accesibil publicului. Calea fiecărui fișier este derivată pe server din tokenul dumneavoastră de autentificare, astfel încât un client să nu poată scrie în folderul altui cont și nici să nu poată alege cărui cont îi aparține un fișier.

Trimiterea conținutului dumneavoastră către furnizorii de servicii de inteligență artificială de mai sus înseamnă că acesta părăsește Moldova și Uniunea Europeană — mai mulți dintre ei prelucrează datele în Statele Unite. După știința noastră, Comisia Europeană nu a adoptat o decizie de adecvare care să acopere Republica Moldova, iar noi nu putem confirma că Statele Unite figurează pe lista statelor recunoscute de autoritatea de supraveghere din Republica Moldova ca asigurând un nivel adecvat de protecție.

Conform art. 32 din Legea nr. 133/2011, un transfer către un stat fără un nivel adecvat de protecție are nevoie de un temei specific. Ne întemeiem pe: **Transferul se efectuează pentru că este necesar în vederea executării acestui contract cu dumneavoastră și cu consimțământul dumneavoastră (Legea nr. 133/2011 art. 32 alin. (5) lit. b) și lit. a)).** Pentru transferurile în afara Uniunii Europene ne întemeiem, pentru fiecare furnizor în parte, pe o decizie de adecvare acolo unde furnizorul este certificat în cadrul EU–US Data Privacy Framework și, în caz contrar, pe Clauzele contractuale standard ale Comisiei Europene. Ne puteți întreba ce mecanism se aplică fiecărui furnizor și puteți cere o copie a clauzelor, scriind la nikolaev.gd@gmail.com — gratuit.

**Avertisment privind riscurile:** deoarece aceste destinații nu sunt acoperite de o decizie de adecvare, datele dumneavoastră pot fi supuse unui nivel de protecție juridică mai scăzut decât cel prevăzut de legislația Republicii Moldova sau de cea a Uniunii Europene, iar acolo puteți avea mai puține căi de atac sau căi de atac mai greu de exercitat. Conținutul conversațiilor dumneavoastră, subtitrările și înregistrările vocale sunt transferate pe această bază.

## Securitatea

Tot traficul dintre browserul dumneavoastră, serverele noastre și furnizorii de servicii de inteligență artificială se desfășoară prin HTTPS/TLS, iar lex-me.club se accesează prin HTTPS, cu un certificat valabil. Accesul la baza de date este restricționat la nivel de cont prin securitate la nivel de rând, legată de tokenul dumneavoastră de autentificare, astfel încât un cont să nu poată citi rândurile altuia. Înregistrările vocale și cele de pronunție se află într-un container de stocare privat, ale cărui căi sunt derivate pe server din tokenul dumneavoastră. Datele cardului de plată nu ajung deloc în sistemele noastre.

Cu toate acestea: nicio transmitere de date prin internet sau printr-o rețea fără fir nu poate fi complet securizată. Vă protejăm datele prin măsuri adecvate riscului, dar nu putem garanta o securitate absolută. Dacă o încălcare a securității afectează datele dumneavoastră, vă vom notifica atât pe dumneavoastră, cât și Centrul Național pentru Protecția Datelor cu Caracter Personal, conform legii.

## Cât timp păstrăm datele

- **Conținutul brut al subtitrărilor** din datele de diagnostic ale captării: golit automat după 30 de zile. Aceasta este singura expirare automată care rulează în prezent.
- **Registrul financiar** — alimentări și cheltuieli: se păstrează 5 ani, pentru că regulile contabile și condițiile de acceptare a cardurilor impun acest lucru. Este singura categorie care supraviețuiește ștergerii contului, în formă depersonalizată.
- **Tot restul de pe server** — sesiunile video, ce se trimite către modele și ce se primește de la ele, transcrierile și înregistrările vocale, replicile de chat, subtitrările procesate, înregistrările de pronunție, setările, adresele IP consemnate la crearea contului — se păstrează atât timp cât există contul dumneavoastră și se șterg când ne cereți să le ștergem sau să vă ștergem contul. **În prezent nu există nicio sarcină de expirare automată pentru aceste categorii**, deci, dacă nu cereți, ele rămân.
- **Datele locale din browser** se curăță în funcție de dimensiune, așa cum s-a descris mai sus; clicurile pe cuvinte și instantaneele apelurilor către modele nu se curăță deloc și dispar la dezinstalare.

Aceasta este o descriere sinceră a situației actuale, nu un obiectiv. Dacă doriți ca datele dumneavoastră să dispară mai devreme, cereți — a se vedea secțiunea următoare.

## Ștergerea contului și a datelor dumneavoastră

**În prezent, Lex nu are un buton de ștergere a contului direct din aplicație.** Pentru ștergerea contului dumneavoastră, scrieți la **nikolaev.gd@gmail.com** de la adresa asociată contului. Îl vom șterge manual.

Ce presupune ștergerea:

- Eliminate automat, pentru că sunt legate de contul dumneavoastră: înregistrările sesiunilor dumneavoastră video, apelurile către modele, inclusiv ce s-a trimis și ce s-a primit, datele de diagnostic ale captării subtitrărilor și înregistrările de pronunție.
- Eliminate manual, ca parte a aceleiași solicitări: replicile dumneavoastră de chat pe fiecare videoclip, subtitrările procesate păstrate în cache, setările dumneavoastră, înregistrările sesiunilor vocale, adresele IP consemnate la crearea contului și fiecare fișier audio de voce și de pronunție stocat pentru contul dumneavoastră. Cereți-ne să confirmăm când este gata.
- **O excepție deliberată:** registrul financiar — evidența alimentărilor de sold și a cheltuielilor — **se păstrează, în formă depersonalizată**. Referința la cont din el nu mai corespunde niciunui cont, dar înregistrările financiare în sine rămân, pentru integritatea contabilă.
- Orice sold pozitiv existent în momentul ștergerii se tratează astfel: **Dacă ne cereți să vă ștergem contul în timp ce mai aveți un sold necheltuit, spuneți-ne și îl vom rambursa înainte de ștergerea contului.**
- Telemetria înregistrată înainte ca autentificarea să devină obligatorie nu poartă niciun identificator de cont, deci nu este ștearsă automat. Ea nu este anonimă: poartă același identificator anonim de instalare descris mai sus. Cereți-ne și vom șterge acele rânduri după identificatorul de instalare, ca parte a solicitării dumneavoastră.
- Datele locale din browserul dumneavoastră se elimină prin dezinstalarea extensiei sau prin golirea spațiului de stocare al extensiei. Nu păstrăm identificatorul de instalare după ștergere.

## Drepturile dumneavoastră

Oricine ați fi și oriunde v-ați afla, ne puteți cere: să vă confirmăm dacă vă prelucrăm datele și să vă furnizăm o copie a acestora; să le corectăm sau să le actualizăm; să le ștergem; să restricționăm sau să blocăm prelucrarea lor; să vi le transmitem într-o formă portabilă. Vă puteți totodată opune prelucrării și vă puteți retrage oricând orice consimțământ pe care l-ați dat. Vă puteți, de asemenea, opune oricând, fără a invoca un motiv, oricărei utilizări a datelor dumneavoastră în scop de prospectare comercială și puteți cere anularea oricărei decizii luate exclusiv prin prelucrare automatizată.

Aceste drepturi sunt acordate în temeiul Legii nr. 133/2011 (art. 12, 13, 14, 16, 17, 18 și 32), care se aplică până la 23 august 2026, iar de la acea dată în temeiul Legii nr. 195/2024 privind protecția datelor cu caracter personal, publicată în Monitorul Oficial nr. 367-369, art. 574, din 23 august 2024, care transpune Regulamentul (UE) 2016/679 în legislația Republicii Moldova. Am redactat această pagină conform standardului Legii nr. 195/2024, astfel încât să nu fie nevoie să o modificăm atunci când acea lege va intra în vigoare. Dacă vă aflați în Uniunea Europeană, aceleași drepturi decurg din GDPR, care ni se aplică în temeiul art. 3 alin. (2) din acesta.

Pentru a exercita oricare dintre acestea, scrieți la **nikolaev.gd@gmail.com** de la adresa de e-mail asociată contului dumneavoastră. Răspundem gratuit, în termen de o lună. Dacă o solicitare este complexă, putem prelungi cu până la două luni suplimentare și vă vom anunța în interiorul primei luni dacă se întâmplă acest lucru. Dacă din solicitare nu putem confirma că sunteți titularul contului, vă vom cere o dovadă în acest sens — și doar atât cât ne este necesar.

Dacă nu sunteți mulțumit de răspunsul nostru, vă puteți adresa oricând cu o plângere autorității de supraveghere de mai jos; nu sunteți obligat să ne întrebați pe noi mai întâi.

### De ce avem dreptul să prelucrăm fiecare categorie

| Ce facem | De ce | Temeiul juridic |
|---|---|---|
| Administrăm contul și soldul dumneavoastră, desfășurăm lecțiile, trimitem mesajele dumneavoastră și subtitrările videoclipului către furnizorii de servicii de inteligență artificială | Pentru a presta serviciul pentru care ați plătit | Executarea contractului (art. 6 alin. (1) lit. b) din GDPR) |
| Stocăm istoricul dumneavoastră de chat și subtitrările procesate, astfel încât să vă urmeze de la un dispozitiv la altul | Parte din serviciu | Executarea contractului |
| Captăm și transmitem sunetul de la microfonul dumneavoastră în modul vocal și în evaluarea pronunției și stocăm înregistrarea și transcrierea | Doar dacă activați aceste funcții | Executarea contractului, la cererea dumneavoastră |
| Consemnăm adresele IP la crearea contului; păstrăm datele de diagnostic ale captării subtitrărilor | Prevenirea abuzurilor la crearea gratuită a conturilor și menținerea în funcțiune a captării subtitrărilor | Interesul legitim (art. 6 alin. (1) lit. f)) — vă puteți opune în temeiul art. 21 |
| Păstrăm registrul financiar timp de 5 ani | Cerințe contabile și de acceptare a cardurilor | Obligație legală (art. 6 alin. (1) lit. c)) |

Lex nu ia decizii automatizate cu efecte juridice sau cu efecte similare semnificative asupra dumneavoastră. Furnizorii de servicii de inteligență artificială generează conținut didactic; ei nu decid nimic cu privire la drepturile dumneavoastră.

### Autoritățile de supraveghere

Pentru datele dumneavoastră cu caracter personal:

**Centrul Național pentru Protecția Datelor cu Caracter Personal** (National Center for Personal Data Protection)
MD-2004, Chișinău, str. Serghei Lazo 48, Republica Moldova
Telefon: (022) 820 801 · E-mail: centru@datepersonale.md · https://datepersonale.md
Luni–vineri, 08:00–17:00

Dacă vă aflați în Uniunea Europeană, vă puteți adresa cu o plângere autorității de supraveghere din țara dumneavoastră.

Pentru reclamații privind serviciul în sine, nu datele dumneavoastră:

**Inspectoratul de Stat pentru Supravegherea Produselor Nealimentare și Protecția Consumatorilor (ISSPNPC)**
State Inspectorate for Supervision of Non-Food Products and Consumer Protection
MD-2012, mun. Chișinău, str. Vasile Alecsandri 78, Republica Moldova
Telefon: 022 51 51 51 · E-mail: secretariat@isspnpc.gov.md · https://consumator.gov.md
Luni–vineri, 08:00–17:00

Această autoritate este indicată aici conform art. 12 alin. (1) lit. j) din Legea nr. 284/2004 și art. 33 alin. (13) din Legea nr. 105/2003.

## Permisiunile de browser și rostul lor

- **activeTab** — permite ca un clic pe pictograma Lex să acționeze asupra filei active.
- **storage** — spațiul local de stocare descris mai sus.
- **scripting** — inserează fereastra de chat Lex peste pagina curentă când o solicitați.
- **downloads** — folosită pentru a salva o copie a datelor Lex stocate local într-un fișier de pe calculatorul dumneavoastră.
- **offscreen** — decodează sunetul când Lex trebuie să transcrie un videoclip fără subtitrări.
- **contextMenus** — elementele din meniul contextual al pictogramei din bara de instrumente.
- **identity** — autentificarea prin Google.
- **Acces la youtube.com** — subtitrările, fereastra suprapusă și chatul.
- **Acces la domeniile furnizorilor de servicii de inteligență artificială și la domeniile serverelor noastre (backend)** enumerate mai sus — apelurile către modele, autentificarea, stocarea și traseul audio.
- **Acces la toate site-urile** — folosit pentru ca fereastra de chat de sine stătătoare să se poată deschide pe orice pagină pe care o aveți deschisă în momentul în care faceți clic pe pictogramă. Injectarea este refuzată pe paginile de browser restricționate. Lex nu citește și nu scrie nimic pe acele pagini; se limitează la afișarea propriei ferestre de chat: nu colectează de acolo conținutul paginii, istoricul de navigare sau datele din formulare. Aceasta este cea mai largă permisiune solicitată de Lex și este cerută exclusiv în acest scop.

## Vârsta

Lex nu este pentru copii. Trebuie să aveți cel puțin 16 ani pentru a crea un cont. Dacă aveți între 13 și 16 ani, iar legea țării dumneavoastră stabilește o vârstă mai mică pentru consimțământul la servicii online, puteți folosi Lex doar cu consimțământul unui părinte sau al unui tutore, iar noi putem cere dovada acestuia.

Nu colectăm cu bună știință date de la persoane care nu au împlinit aceste vârste. Dacă credeți că un copil a creat un cont, scrieți la nikolaev.gd@gmail.com și vom șterge contul și datele acestuia.

## Modificările acestei politici

Dacă practicile noastre privind datele se schimbă, vom actualiza această pagină și vom informa utilizatorii existenți despre schimbare, în loc să o modificăm în tăcere.

---

Această politică de confidențialitate face parte din [Termeni și condiții](https://lex-me.club/termeni) ai lex-me.club și este încorporată în aceștia ca secțiunile „Protecția datelor cu caracter personal” și „Politica de confidențialitate”. Prin acceptarea Termenilor și condițiilor la finalizarea comenzii, acceptați și această politică.

---
