# Cómo publicar un paquete en npm — guía general

Reglas y trampas del registro npm, válidas para cualquier repo. Fuente de
verdad: la API del registro (`npm view`), nunca la página web.

## 1. Checklist antes de publicar

1. Subir la versión en `package.json` (semver: patch = fixes, minor =
   features compatibles, major = breaking).
2. Correr los checks del repo (format/lint/tests) desde un **árbol limpio**.
3. Commit + push. Si el repo tiene CI de releases, verifica si crea el
   release de GitHub automáticamente.

## 2. Primera vez en un nombre nuevo

- El nombre no debe existir (o debes ser su dueño): `npm view <paquete>` →
  404 = libre. Nombres no-scoped no necesitan `--access public`; los
  scoped (`@usuario/paquete`) sí: `npm publish --access public`.
- Si el nombre fue **despublicado** hace más de 24 h, cualquiera puede
  tomarlo — publica pronto o usa un nombre scoped.

## 3. Publicar

```bash
npm whoami              # confirma la sesión correcta
npm publish --dry-run   # revisa qué entra al tarball (campo "files")
npm publish             # corre prepublishOnly y pide OTP (2FA)
```

- **Versiones de prueba / beta**: `npm publish --tag beta` (o `stage`,
  `next`). NUNCA publiques una versión de prueba sin `--tag`: cualquier
  `npm publish` sin tag mueve `latest` a lo recién publicado, aunque la
  versión sea "0.0.0-beta". npm no compara semver para decidir `latest`.
- Si `latest` quedó apuntando mal:
  `npm dist-tag add <paquete>@X.Y.Z latest`.
- `npm publish` **no lee git**: empaqueta el directorio actual. Un árbol
  sucio se publica sucio.

## 4. Verificación post-publish

```bash
npm view <paquete> dist-tags versions time
curl -sI https://registry.npmjs.org/<paquete>/-/<paquete>-X.Y.Z.tgz   # debe dar HTTP 200
```

La página npmjs.com va **atrasada** respecto al registro: cache de CDN +
estado "Validating" mientras el registro corre sus chequeos automáticos de
la versión nueva (endpoint:
`GET /-/package/{name}/version/{version}/status`, requiere auth).
Normal: se resuelve solo en minutos. Si la validación falla, npm avisa por
correo al publicador.

## 5. Reglas del registro npm

- **Unpublish**: solo dentro de 72 h y sin dependientes. Un número de
  versión despublicado **no se puede reutilizar jamás** — al despublicar
  1.2.3, ese número queda quemado para siempre.
- **Paquetes con `postinstall`**: npm ≥ 11 advierte y pide confirmación al
  usuario; algunos instalan con `--ignore-scripts`. El paquete debe
  degradar bien sin ese script, o documentarlo.
- Declara `engines` si necesitas una versión mínima de Node.

## 6. Gotchas del README

- **Links relativos → 404 en npmjs.com**: la página del paquete no resuelve
  rutas contra el repo. Todo link a un archivo del repo va con URL absoluta
  (`https://github.com/<usuario>/<repo>/blob/main/...`).
- La página bloquea bots (403): verifica el contenido publicado desde el
  tarball o la API, no scrapeando el HTML.

## 7. Token de npm (solo si publicas desde CI)

1. npmjs.com → avatar → Access Tokens → **Granular Access Token**
   (evita los classic, están desaconsejados).
2. **Primera publicación**: el paquete no existe, así que el token no puede
   restringirse a él — hay que dar "All packages → Read and write".
3. **Publicaciones siguientes**: genera un token nuevo restringido a
   "Only select packages → <paquete> → Read and write" y reemplaza el
   anterior (menor daño si se filtra).
4. Expiration máx. 365 días. En GitHub: secret `NPM_TOKEN` + usarlo como
   `NODE_AUTH_TOKEN` con `registry-url: https://registry.npmjs.org/`.
5. Alternativa sin token: **Trusted Publishing (OIDC)** desde GitHub
   Actions (`id-token: write` + publisher autorizado en npmjs.com).

## 8. Qué se empaqueta

El campo `files` de package.json (+ README, LICENSE, package.json siempre).
Siempre hay un `--dry-run` antes para ver el listado final. Cuidado con
`.env`, `node_modules/`, fuentes y tests colándose al tarball.
