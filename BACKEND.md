# Backend: account clienti e sicurezza (Spring Boot)

Il frontend ora **richiede un account per prenotare**, ma la vera protezione sta qui: finché il server accetta
`POST /api/appuntamenti` senza token, chiunque può prenotare con `curl` e saltare la pagina.
Il codice sotto è un punto di partenza da **adattare ai tuoi package, nomi di colonna e al tuo JWT esistente**:
non l'ho potuto compilare contro il tuo progetto.

Finché il backend non è pronto, metti `REQUIRE_CUSTOMER_LOGIN: false` in `config.js`: il frontend torna a
prenotare senza account.

---

## 1. Idea in breve

| Chi | Come si autentica | Cosa può fare |
|---|---|---|
| Visitatore | niente | leggere strutture, servizi, risorse, disponibilità |
| **Cliente** (nuovo) | email + password → JWT con `role=CLIENTE` | prenotare, vedere e annullare **solo le proprie** prenotazioni |
| Admin / Staff (esistente) | codice struttura + password → JWT | gestione della propria struttura |

Punti chiave:
- Il token cliente **non deve mai** aprire gli endpoint admin (ruoli separati, controllati in `SecurityFilterChain`).
- Nome ed email della prenotazione vengono **dall'account**, mai dal body della richiesta.
- Risposte identiche per "email esistente / non esistente" (niente enumerazione degli utenti).
- Token di verifica/reset: casuali, **salvati solo come hash**, a scadenza, monouso.

---

## 2. Contratto API (quello che il frontend chiama)

| Metodo e percorso | Auth | Body → risposta |
|---|---|---|
| `POST /api/clienti/registrazione` | no | `{nome,email,telefono?,password,privacyAccettata,trattamentoDatiAccettato}` → `201 {message}` (sempre uguale, anche se l'email esiste) |
| `POST /api/clienti/verifica-email` | no | `{token}` → `200` |
| `POST /api/clienti/login` | no | `{email,password}` → `{token,nome,email}`; `401 "Credenziali non valide"`; `403 "Conferma prima il tuo indirizzo email"` |
| `POST /api/clienti/password-dimenticata` | no | `{email}` → **sempre** `200` |
| `POST /api/clienti/password-reset` | no | `{token,nuovaPassword}` → `200` |
| `GET /api/clienti/me/appuntamenti` | cliente | → lista con `id,codice,strutturaId,strutturaNome,tipoServizioNome,risorsaNome,inizio,fine,status` |
| `DELETE /api/clienti/me` | cliente | elimina l'account e i dati personali |
| `POST /api/appuntamenti` | **cliente** | come oggi (il server ignora nome/email del body) |
| `POST /api/appuntamenti/annulla` | **cliente** | `{codice,strutturaId}`; solo se l'appuntamento è suo, altrimenti `404` |
| `POST /api/stream/ticket` | admin | → `{ticket}` valido 30 s, monouso (opzionale, vedi §7) |

Gli errori devono avere la forma `{ "message": "..." }`, che il frontend mostra all'utente.
I link nelle email puntano a `https://TUO-SITO/#verify=TOKEN` e `https://TUO-SITO/#reset=TOKEN`
(il frammento dopo `#` non arriva mai ai log del server).

---

## 3. Database (PostgreSQL)

```sql
CREATE TABLE clienti (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               varchar(254) NOT NULL UNIQUE,      -- sempre in minuscolo
  password_hash       varchar(100) NOT NULL,
  nome                varchar(120) NOT NULL,
  telefono            varchar(30),
  email_verificata    boolean      NOT NULL DEFAULT false,
  verifica_hash       varchar(64),
  verifica_scadenza   timestamptz,
  reset_hash          varchar(64),
  reset_scadenza      timestamptz,
  tentativi_falliti   int          NOT NULL DEFAULT 0,
  bloccato_fino       timestamptz,
  token_version       int          NOT NULL DEFAULT 0,   -- si incrementa al cambio password: invalida i vecchi JWT
  privacy_accettata_il timestamptz NOT NULL,
  creato_il           timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ON clienti (verifica_hash);
CREATE INDEX ON clienti (reset_hash);

ALTER TABLE appuntamenti ADD COLUMN cliente_id uuid REFERENCES clienti(id) ON DELETE SET NULL;
CREATE INDEX ON appuntamenti (cliente_id, inizio);

-- Anti doppia prenotazione A LIVELLO DATABASE (due richieste simultanee non possono sovrapporsi).
-- Adatta i nomi delle colonne ai tuoi.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE appuntamenti ADD CONSTRAINT no_sovrapposizioni
  EXCLUDE USING gist (risorsa_id WITH =, tstzrange(inizio, fine) WITH &&)
  WHERE (status = 'CONFERMATO');
```

---

## 4. Codice

### 4.1 Entity e utilità token

```java
@Entity @Table(name = "clienti")
@Getter @Setter
public class Cliente {
  @Id @GeneratedValue(strategy = GenerationType.UUID) private UUID id;
  @Column(nullable = false, unique = true) private String email;
  @Column(name = "password_hash", nullable = false) private String passwordHash;
  @Column(nullable = false) private String nome;
  private String telefono;
  @Column(name = "email_verificata") private boolean emailVerificata;
  @Column(name = "verifica_hash") private String verificaHash;
  @Column(name = "verifica_scadenza") private Instant verificaScadenza;
  @Column(name = "reset_hash") private String resetHash;
  @Column(name = "reset_scadenza") private Instant resetScadenza;
  @Column(name = "tentativi_falliti") private int tentativiFalliti;
  @Column(name = "bloccato_fino") private Instant bloccatoFino;
  @Column(name = "token_version") private int tokenVersion;
  @Column(name = "privacy_accettata_il", nullable = false) private Instant privacyAccettataIl;
}

public interface ClienteRepository extends JpaRepository<Cliente, UUID> {
  Optional<Cliente> findByEmail(String email);
  Optional<Cliente> findByVerificaHash(String h);
  Optional<Cliente> findByResetHash(String h);
  boolean existsByEmail(String email);
}

@Component
public class TokenUtil {
  private static final SecureRandom RNG = new SecureRandom();
  /** Token casuale da 256 bit, adatto ai link nelle email. */
  public String nuovo() {
    byte[] b = new byte[32]; RNG.nextBytes(b);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
  }
  /** Nel database si salva solo l'hash: se il DB trapela, i link non sono utilizzabili. */
  public String hash(String t) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(t.getBytes(StandardCharsets.UTF_8))); }
    catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
  }
}
```

### 4.2 Richieste con validazione

```java
public record RegistrazioneReq(
  @NotBlank @Size(min = 2, max = 120) String nome,
  @NotBlank @Email @Size(max = 254) String email,
  @Size(max = 30) String telefono,
  @NotBlank @Size(min = 10, max = 72) String password,   // 72 = limite di BCrypt
  @AssertTrue boolean privacyAccettata,
  @AssertTrue boolean trattamentoDatiAccettato) {}

public record LoginReq(@NotBlank String email, @NotBlank String password) {}
public record TokenReq(@NotBlank String token) {}
public record EmailReq(@NotBlank @Email String email) {}
public record ResetReq(@NotBlank String token, @NotBlank @Size(min = 10, max = 72) String nuovaPassword) {}
```
Aggiungi anche un controllo "almeno una lettera e un numero" (come fa il frontend) in un validator o nel service.

### 4.3 Service

```java
@Service
@RequiredArgsConstructor
public class ClienteAuthService {
  private final ClienteRepository clienti;
  private final PasswordEncoder encoder;          // new BCryptPasswordEncoder(12)
  private final TokenUtil tokens;
  private final MailService mail;                 // vedi nota sulle email in fondo
  private final JwtService jwt;                   // il tuo servizio JWT: aggiungi creaTokenCliente()
  @Value("${app.frontend-url}") private String frontendUrl;

  // hash fittizio: il login con email inesistente impiega lo stesso tempo di uno con email esistente
  private static final String DUMMY = new BCryptPasswordEncoder(12).encode("dummy-password");
  private static String norm(String e) { return e.trim().toLowerCase(Locale.ROOT); }

  @Transactional
  public void registra(RegistrazioneReq r) {
    String email = norm(r.email());
    if (clienti.existsByEmail(email)) { mail.avvisoGiaRegistrato(email); return; }   // stessa risposta al client
    Cliente c = new Cliente();
    c.setEmail(email); c.setNome(r.nome().trim()); c.setTelefono(r.telefono());
    c.setPasswordHash(encoder.encode(r.password()));
    c.setPrivacyAccettataIl(Instant.now());
    String t = tokens.nuovo();
    c.setVerificaHash(tokens.hash(t)); c.setVerificaScadenza(Instant.now().plus(24, ChronoUnit.HOURS));
    try { clienti.save(c); } catch (DataIntegrityViolationException e) { return; }   // registrazione doppia simultanea
    mail.verificaEmail(email, frontendUrl + "/#verify=" + t);
  }

  @Transactional
  public void verifica(String token) {
    Cliente c = clienti.findByVerificaHash(tokens.hash(token))
        .filter(x -> x.getVerificaScadenza() != null && x.getVerificaScadenza().isAfter(Instant.now()))
        .orElseThrow(() -> new ApiException(400, "Link non valido o scaduto"));
    c.setEmailVerificata(true); c.setVerificaHash(null); c.setVerificaScadenza(null);
  }

  @Transactional(noRollbackFor = ApiException.class)   // i tentativi falliti devono essere salvati anche se lanciamo l'eccezione
  public LoginRes login(LoginReq r) {
    Cliente c = clienti.findByEmail(norm(r.email())).orElse(null);
    if (c == null) { encoder.matches(r.password(), DUMMY); throw credenziali(); }
    if (c.getBloccatoFino() != null && c.getBloccatoFino().isAfter(Instant.now())) throw credenziali();
    if (!encoder.matches(r.password(), c.getPasswordHash())) {
      int n = c.getTentativiFalliti() + 1;
      if (n >= 5) { c.setBloccatoFino(Instant.now().plus(15, ChronoUnit.MINUTES)); n = 0; }
      c.setTentativiFalliti(n);
      throw credenziali();
    }
    if (!c.isEmailVerificata()) throw new ApiException(403, "Conferma prima il tuo indirizzo email");
    c.setTentativiFalliti(0); c.setBloccatoFino(null);
    return new LoginRes(jwt.creaTokenCliente(c.getId(), c.getTokenVersion()), c.getNome(), c.getEmail());
  }
  private ApiException credenziali() { return new ApiException(401, "Credenziali non valide"); }

  @Transactional
  public void richiediReset(String emailRaw) {     // il controller risponde SEMPRE 200
    clienti.findByEmail(norm(emailRaw)).ifPresent(c -> {
      String t = tokens.nuovo();
      c.setResetHash(tokens.hash(t)); c.setResetScadenza(Instant.now().plus(1, ChronoUnit.HOURS));
      mail.resetPassword(c.getEmail(), frontendUrl + "/#reset=" + t);
    });
  }

  @Transactional
  public void reset(ResetReq r) {
    Cliente c = clienti.findByResetHash(tokens.hash(r.token()))
        .filter(x -> x.getResetScadenza() != null && x.getResetScadenza().isAfter(Instant.now()))
        .orElseThrow(() -> new ApiException(400, "Link non valido o scaduto"));
    c.setPasswordHash(encoder.encode(r.nuovaPassword()));
    c.setResetHash(null); c.setResetScadenza(null);
    c.setTokenVersion(c.getTokenVersion() + 1);     // tutti i JWT già emessi smettono di valere
    c.setTentativiFalliti(0); c.setBloccatoFino(null);
  }
}
```

`ApiException(int status, String message)` è la tua eccezione applicativa mappata da un `@RestControllerAdvice`
su `{ "message": ... }` con lo status indicato. **Non** restituire mai stack trace o dettagli SQL
(`server.error.include-stacktrace=never`).

### 4.4 Controller

```java
@RestController @RequestMapping("/api/clienti") @RequiredArgsConstructor
public class ClienteController {
  private final ClienteAuthService auth;
  private final ClienteService clienteService;   // me, appuntamenti, eliminazione

  @PostMapping("/registrazione") @ResponseStatus(HttpStatus.CREATED)
  public Map<String,String> registra(@Valid @RequestBody RegistrazioneReq r) {
    auth.registra(r);
    return Map.of("message", "Account creato. Controlla la tua email e conferma l'indirizzo, poi accedi.");
  }
  @PostMapping("/verifica-email") public void verifica(@Valid @RequestBody TokenReq r) { auth.verifica(r.token()); }
  @PostMapping("/login") public LoginRes login(@Valid @RequestBody LoginReq r) { return auth.login(r); }
  @PostMapping("/password-dimenticata") public void dimenticata(@Valid @RequestBody EmailReq r) { auth.richiediReset(r.email()); }
  @PostMapping("/password-reset") public void reset(@Valid @RequestBody ResetReq r) { auth.reset(r); }

  @GetMapping("/me/appuntamenti")
  public List<AppuntamentoClienteRes> miei(@AuthenticationPrincipal ClientePrincipal p) { return clienteService.appuntamenti(p.id()); }

  @DeleteMapping("/me") @ResponseStatus(HttpStatus.NO_CONTENT)
  public void elimina(@AuthenticationPrincipal ClientePrincipal p) { clienteService.eliminaAccount(p.id()); }
}
```

`eliminaAccount`: annulla le prenotazioni future (`CONFERMATO` con `inizio > now()`), poi cancella la riga in `clienti`
(`ON DELETE SET NULL` lascia lo storico anonimo; se salvi nome/telefono anche nell'appuntamento, azzerali).

### 4.5 JWT: ruoli separati

Nel tuo `JwtService` aggiungi un metodo per il cliente e **non riusare** lo stesso formato dell'admin:

```java
public String creaTokenCliente(UUID id, int version) {
  return Jwts.builder()                       // adatta alla libreria che usi (jjwt, nimbus, ...)
      .subject(id.toString())
      .claim("role", "CLIENTE").claim("ver", version)
      .issuedAt(new Date()).expiration(Date.from(Instant.now().plus(12, ChronoUnit.HOURS)))
      .signWith(key)                          // chiave da variabile d'ambiente, almeno 256 bit
      .compact();
}
```

Nel filtro JWT, se `role == CLIENTE`: carica il cliente, **confronta `ver` con `token_version`** (se diverso → 401) e imposta
l'autenticazione con authority `ROLE_CLIENTE`. Per i token admin resta `ROLE_ADMIN` / `ROLE_STAFF`.

### 4.6 Regole di accesso

```java
@Bean
SecurityFilterChain chain(HttpSecurity http, JwtFilter jwtFilter, RateLimitFilter rateLimit) throws Exception {
  return http
    .csrf(c -> c.disable())                                   // solo header Authorization, niente cookie -> niente CSRF
    .cors(Customizer.withDefaults())
    .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
    .authorizeHttpRequests(a -> a
      .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
      .requestMatchers(HttpMethod.GET, "/api/health", "/api/strutture", "/api/risorse/pubbliche",
                       "/api/tipi-servizio", "/api/disponibilita").permitAll()
      .requestMatchers(HttpMethod.POST, "/api/auth/login", "/api/clienti/registrazione", "/api/clienti/login",
                       "/api/clienti/verifica-email", "/api/clienti/password-dimenticata",
                       "/api/clienti/password-reset").permitAll()
      .requestMatchers("/api/clienti/me", "/api/clienti/me/**").hasRole("CLIENTE")
      .requestMatchers(HttpMethod.POST, "/api/appuntamenti", "/api/appuntamenti/annulla").hasRole("CLIENTE")
      .requestMatchers("/api/**").hasAnyRole("ADMIN", "STAFF")       // tutto il resto: solo gestione
      .anyRequest().denyAll())
    .addFilterBefore(rateLimit, UsernamePasswordAuthenticationFilter.class)
    .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class)
    .headers(h -> h.frameOptions(f -> f.deny()).contentTypeOptions(Customizer.withDefaults()))
    .build();
}

@Bean
CorsConfigurationSource cors(@Value("${app.cors.origins}") List<String> origins) {
  var c = new CorsConfiguration();
  c.setAllowedOrigins(origins);                               // solo il tuo sito, MAI "*" in produzione
  c.setAllowedMethods(List.of("GET", "POST", "PATCH", "DELETE", "OPTIONS"));
  c.setAllowedHeaders(List.of("Authorization", "Content-Type"));
  c.setMaxAge(3600L);
  var s = new UrlBasedCorsConfigurationSource(); s.registerCorsConfiguration("/api/**", c); return s;
}
```

### 4.7 Creazione della prenotazione (il punto più delicato)

```java
@Transactional
public AppuntamentoRes crea(UUID clienteId, NuovoAppuntamentoReq r) {
  Cliente cliente = clienti.findById(clienteId).orElseThrow(() -> new ApiException(401, "Sessione non valida"));

  // 1. risorsa e servizio devono appartenere alla struttura indicata (anti-IDOR)
  Risorsa ris = risorse.findByIdAndStrutturaId(r.risorsaId(), r.strutturaId()).filter(Risorsa::isAttiva)
      .orElseThrow(() -> new ApiException(404, "Risorsa non trovata"));
  TipoServizio srv = tipi.findByIdAndStrutturaId(r.tipoServizioId(), r.strutturaId()).filter(TipoServizio::isAttivo)
      .orElseThrow(() -> new ApiException(404, "Servizio non trovato"));

  // 2. l'orario deve essere uno slot REALMENTE offerto (ricalcolalo lato server, non fidarti di "inizio")
  if (!disponibilita.slotLibero(ris, srv, r.inizio())) throw new ApiException(409, "Orario non più disponibile");

  // 3. limite per cliente: niente prenotazioni di massa
  if (appuntamenti.countByClienteIdAndStatusAndInizioAfter(clienteId, "CONFERMATO", Instant.now()) >= 5)
    throw new ApiException(429, "Hai già 5 prenotazioni in programma");

  // 4. i dati personali vengono dall'ACCOUNT, non dal body
  Appuntamento a = new Appuntamento();
  a.setCliente(cliente); a.setNomeCliente(cliente.getNome()); a.setEmail(cliente.getEmail());
  a.setTelefono(r.telefono()); a.setNote(r.note());                  // validare lunghezza: note <= 500
  a.setCodice(codiceCasuale());                                      // SecureRandom, 8 caratteri senza 0/O/1/I
  try { return map(appuntamenti.saveAndFlush(a)); }
  catch (DataIntegrityViolationException e) { throw new ApiException(409, "Orario non più disponibile"); }  // vincolo no_sovrapposizioni
}

@Transactional
public void annulla(UUID clienteId, String codice, UUID strutturaId) {
  Appuntamento a = appuntamenti.findByCodiceAndStrutturaId(codice.trim().toUpperCase(Locale.ROOT), strutturaId)
      .filter(x -> x.getCliente() != null && x.getCliente().getId().equals(clienteId))
      .orElseThrow(() -> new ApiException(404, "Prenotazione non trovata"));   // 404, non 403: non rivelare che esiste
  a.setStatus("CANCELLATO");
}
```

### 4.8 Rate limiting (Bucket4j + Caffeine)

```java
@Component
public class RateLimitFilter extends OncePerRequestFilter {
  private final Cache<String, Bucket> buckets = Caffeine.newBuilder().expireAfterAccess(Duration.ofHours(1)).maximumSize(100_000).build();

  private int limitePerMinuto(String method, String path) {
    if (!method.equals("POST")) return 0;
    return switch (path) {
      case "/api/auth/login", "/api/clienti/login" -> 10;
      case "/api/clienti/registrazione" -> 5;
      case "/api/clienti/password-dimenticata", "/api/clienti/password-reset" -> 3;
      case "/api/appuntamenti", "/api/appuntamenti/annulla" -> 10;
      default -> 0;
    };
  }

  @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws IOException, ServletException {
    int max = limitePerMinuto(req.getMethod(), req.getRequestURI());
    if (max > 0) {
      Bucket b = buckets.get(req.getRemoteAddr() + "|" + req.getRequestURI(),
          k -> Bucket.builder().addLimit(Bandwidth.simple(max, Duration.ofMinutes(1))).build());
      if (!b.tryConsume(1)) {
        res.setStatus(429); res.setHeader("Retry-After", "60"); res.setContentType("application/json");
        res.getWriter().write("{\"message\":\"Troppe richieste, riprova tra un minuto.\"}");
        return;
      }
    }
    chain.doFilter(req, res);
  }
}
```
Dietro Render/Vercel l'IP reale è nell'header `X-Forwarded-For`: imposta `server.forward-headers-strategy=framework`
così `getRemoteAddr()` restituisce l'IP del client e non quello del proxy.

---

## 5. `application.properties`

```properties
app.frontend-url=https://TUO-SITO.vercel.app
app.cors.origins=https://TUO-SITO.vercel.app
app.jwt.secret=${JWT_SECRET}                  # openssl rand -base64 48   (mai nel repository)
server.forward-headers-strategy=framework
server.error.include-stacktrace=never
server.error.include-message=never
management.endpoints.web.exposure.include=health   # niente actuator aperto
spring.jpa.open-in-view=false
```

---

## 6. Email (verifica, reset)

Serve un invio email dal backend: `spring-boot-starter-mail` con SMTP di un provider (Brevo, Resend, Mailjet o il tuo).
Sul dominio da cui spedisci configura **SPF, DKIM e DMARC**, altrimenti le email finiscono in spam.
Il testo deve contenere solo il link e una frase tipo «se non sei stato tu, ignora questa email».

---

## 7. Ticket per il live stream (facoltativo ma consigliato)

Oggi `EventSource` non può mandare header, quindi il token admin viaggia nell'URL `/api/stream?token=...` e finisce
nei log. Il frontend prova prima `POST /api/stream/ticket` e, se esiste, usa `?ticket=...` (monouso, 30 secondi):

```java
private final Cache<String, AdminPrincipal> tickets = Caffeine.newBuilder().expireAfterWrite(Duration.ofSeconds(30)).build();

@PostMapping("/api/stream/ticket")                 // protetto da JWT admin
public Map<String,String> ticket(@AuthenticationPrincipal AdminPrincipal p) {
  String t = tokens.nuovo(); tickets.put(t, p); return Map.of("ticket", t);
}
// nel filtro JWT, solo per /api/stream: se c'è ?ticket=, consumalo (tickets.asMap().remove(t)) e autentica quell'admin;
// continua ad accettare ?token= finché non hai aggiornato tutti i client.
```

---

## 8. Controlli da fare sul codice che hai già

1. **Isolamento tra strutture**: ogni query admin deve filtrare per `strutturaId` preso dal **JWT**, mai da un parametro
   della richiesta. Prova: accedi a `DEMO`, prendi un `id` di un'altra struttura e chiamalo su `PATCH/DELETE`: deve dare 404.
2. **Seed `DEMO`**: in produzione disattiva il seed e usa password lunghe; cambia quella iniziale.
3. **Segreto JWT** da variabile d'ambiente, almeno 256 bit; durata admin 8 ore al massimo.
4. **Login admin**: stesso blocco dopo 5 tentativi falliti e stesso rate limit del cliente.
5. **Log**: mai password, token o corpo delle richieste di login.
6. **HTTPS** ovunque (Render e Vercel lo fanno già); niente `http://` in `app.cors.origins`.
7. **Dipendenze**: attiva Dependabot su GitHub e aggiorna Spring Boot con regolarità.
8. **Backup** del database con retention e prova di ripristino.
9. **Anti-bot**: aggiungi Cloudflare Turnstile (gratuito) alla registrazione e verifica il token sul server.
   Nel frontend serve la site key: dimmelo e lo aggiungo.
10. **GDPR**: conserva `privacy_accettata_il`, tieni la pagina informativa raggiungibile dai due consensi e usa
    `DELETE /api/clienti/me` per la cancellazione su richiesta.

---

## 9. Test rapidi (da lanciare dopo il deploy)

```bash
API=https://tuo-backend.onrender.com

# 1. senza token NON si prenota: atteso 401
curl -i -X POST $API/api/appuntamenti -H 'Content-Type: application/json' -d '{}'

# 2. il token cliente NON apre la gestione: atteso 403
curl -i $API/api/risorse -H "Authorization: Bearer $TOKEN_CLIENTE"

# 3. non esiste enumerazione: stessa risposta per email esistente e inesistente
curl -s -X POST $API/api/clienti/password-dimenticata -H 'Content-Type: application/json' -d '{"email":"nessuno@example.com"}' -w '%{http_code}\n'

# 4. rate limit: dal 11° tentativo in un minuto atteso 429
for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' -X POST $API/api/clienti/login \
  -H 'Content-Type: application/json' -d '{"email":"a@b.it","password":"x"}'; done; echo

# 5. CORS: da un'origine diversa dal tuo sito non deve comparire Access-Control-Allow-Origin
curl -i -X OPTIONS $API/api/appuntamenti -H 'Origin: https://sito-malevolo.example' -H 'Access-Control-Request-Method: POST'
```

---

## 10. Nuovo appuntamento inserito dall'admin (pulsante «+» in agenda)

Il pulsante blu «+» dell'agenda usa lo stesso flusso del cliente (servizio → giorno → orario → dati).

- Con `REQUIRE_CUSTOMER_LOGIN: false` il frontend chiama `POST /api/appuntamenti` con il token admin: funziona senza modifiche.
- Con `REQUIRE_CUSTOMER_LOGIN: true` il `POST /api/appuntamenti` è riservato a `ROLE_CLIENTE` (vedi §4.6) e l'admin riceverebbe 403.
  Serve un endpoint dedicato, che il frontend chiama già: `POST /api/admin/appuntamenti`
  - `hasAnyRole("ADMIN","STAFF")`; la `strutturaId` va presa dal **JWT**, non dal body (isolamento tra strutture, §8.1);
  - stesso body di oggi (`risorsaId, tipoServizioId, inizio, nomeCliente, telefono, email?, note?, consensi`) e stessi controlli di `crea()` (§4.7: risorsa/servizio della struttura, slot realmente libero, vincolo `no_sovrapposizioni`);
  - nome/telefono/email arrivano dal body (il paziente non ha un account), `cliente_id` resta `NULL`;
  - risposta `201` con `{codice, ...}`; errore `409` se lo slot è appena stato occupato.
