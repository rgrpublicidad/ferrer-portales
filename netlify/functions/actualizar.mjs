/**
 * Netlify Scheduled Function - Actualización diaria de limpieza de portales
 * Edificio Ferrer y Perdomo (Las Palmas de Gran Canaria)
 *
 * Se ejecuta cada día a las 7:00 UTC (8:00 hora Canarias invierno / 8:00 verano)
 * Lee los partes de conserje@ferreryperdomo.com, extrae los portales limpiados
 * del PDF adjunto, y actualiza el index.html en GitHub → Netlify lo publica.
 */

import { google } from 'googleapis';
import { Octokit } from '@octokit/rest';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convierte una fecha JS a "DD/MM" en zona horaria de Canarias */
function fechaCorta(date) {
  return date.toLocaleDateString('es-ES', {
    timeZone: 'Atlantic/Canary',
    day: '2-digit',
    month: '2-digit',
  });
}

/** Convierte una fecha JS al día de la semana abreviado en español */
function diaSemana(date) {
  const dias = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const d = new Date(date.toLocaleString('en-US', { timeZone: 'Atlantic/Canary' }));
  return dias[d.getDay()];
}

/** Normaliza el nombre del turno al código corto */
function normalizaTurno(turno) {
  const t = turno.toLowerCase();
  if (t.includes('lunes') && t.includes('mañana')) return 'L-V mañana';
  if (t.includes('lunes') && t.includes('tarde'))  return 'L-V tarde';
  if (t.includes('laborables') && t.includes('mañana')) return 'No lab. mañana';
  if (t.includes('laborables') && t.includes('tarde'))  return 'No lab. tarde';
  return turno;
}

/**
 * Extrae qué portales (26-33) aparecen mencionados como limpios en el texto del PDF.
 * Busca patrones como "portal 26", "portales 26,27,28,29", etc.
 * Devuelve un Set con los números de portal encontrados.
 */
function extraePortales(texto) {
  const portalesLimpios = new Set();
  const textoNorm = texto.toLowerCase();

  // Busca "portal(es) XX" o "portal(es) XX, YY, ZZ"
  const patron = /portales?\s+([\d\s,yY]+)/g;
  let m;
  while ((m = patron.exec(textoNorm)) !== null) {
    const numeros = m[1].match(/\d+/g) || [];
    for (const n of numeros) {
      const num = parseInt(n);
      if (num >= 26 && num <= 33) portalesLimpios.add(num);
    }
  }

  // También busca números individuales seguidos de contexto de limpieza
  // p.ej. "limpio el portal 33"
  const patron2 = /(?:limpi(?:o|é|a)|barri(?:ó|o)|freg(?:ó|o))\s+(?:el\s+)?portal\s+(\d+)/g;
  while ((m = patron2.exec(textoNorm)) !== null) {
    const num = parseInt(m[1]);
    if (num >= 26 && num <= 33) portalesLimpios.add(num);
  }

  return portalesLimpios;
}

/** Descarga el adjunto PDF de un mensaje de Gmail y devuelve su texto */
async function descargaYLeePdf(gmail, messageId, attachmentId) {
  const resp = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  // Los datos vienen en base64 con URL-safe encoding (- en vez de +, _ en vez de /)
  const base64 = resp.data.data.replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(base64, 'base64');
  try {
    const parsed = await pdfParse(buffer);
    return parsed.text;
  } catch {
    return '';
  }
}

// ─── HTML ────────────────────────────────────────────────────────────────────

/** Genera una celda de la tabla */
function celda(limpio, conserje) {
  if (limpio) {
    return `<td class="limpio"><span class="ok">✔</span><small>${conserje}</small></td>`;
  }
  return `<td class="vacio"></td>`;
}

/** Genera una fila de la tabla a partir de los datos de un parte */
function generaFila(fecha, turno, conserje, portalesLimpios) {
  const dd = fechaCorta(fecha);
  const dia = diaSemana(fecha);
  const turnoCorto = normalizaTurno(turno);

  const celdas = [26, 27, 28, 29, 30, 31, 32, 33]
    .map(p => celda(portalesLimpios.has(p), conserje))
    .join('\n      ');

  return `
    <tr>
      <td class="col-fecha"><span class="semana-label">${dia} ${dd}</span><br><small>${turnoCorto}</small></td>
      ${celdas}
    </tr>`;
}

/** Genera el HTML completo a partir de todas las filas */
function generaHtml(filas, totales, fechaActualizacion) {
  const filasHtml = filas.join('\n');

  const totalesHtml = [26, 27, 28, 29, 30, 31, 32, 33]
    .map(p => `<td>${totales[p] || 0}</td>`)
    .join('\n      ');

  // Rango de fechas para el subtítulo de totales
  const primeraFecha = filas.length > 0 ? 'inicio' : '-';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Limpieza de portales - Ferrer y Perdomo</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; margin: 40px; color: #222; }
  h1 { font-size: 20px; color: #1a3a5c; border-bottom: 2px solid #1a3a5c; padding-bottom: 6px; margin-bottom: 4px; }
  p.subtitulo { font-size: 12px; color: #666; margin-top: 2px; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
  th { background: #1a3a5c; color: #fff; padding: 7px 10px; text-align: center; font-size: 12px; }
  th.col-fecha { text-align: left; width: 130px; }
  td { border: 1px solid #c8d4e0; padding: 7px 6px; vertical-align: middle; font-size: 12px; text-align: center; }
  td.col-fecha { text-align: left; }
  .ok { color: #2a7a2a; font-weight: bold; font-size: 14px; }
  .nota { font-size: 11px; color: #555; margin-top: 16px; border-left: 3px solid #1a3a5c; padding-left: 8px; }
  .semana-label { font-weight: bold; color: #1a3a5c; }
  small { color: #555; display: block; font-size: 10px; }
  .limpio { background: #eaf5ea; }
  .vacio { background: #f9f9f9; }
  .totales { background: #1a3a5c; color: #fff; font-weight: bold; }
  .totales td { color: #fff; border-color: #2a5a8c; }
</style>
</head>
<body>

<h1>Recuento de limpieza por portal - Edificio Ferrer y Perdomo</h1>
<p class="subtitulo">Fuente: PDFs adjuntos a los partes de conserje@ferreryperdomo.com &nbsp;|&nbsp; Actualizado: ${fechaActualizacion}</p>

<table>
  <thead>
    <tr>
      <th class="col-fecha">Fecha / turno</th>
      <th>Portal 26</th>
      <th>Portal 27</th>
      <th>Portal 28</th>
      <th>Portal 29</th>
      <th>Portal 30</th>
      <th>Portal 31</th>
      <th>Portal 32</th>
      <th>Portal 33</th>
    </tr>
  </thead>
  <tbody>
${filasHtml}

    <tr class="totales">
      <td class="col-fecha" style="color:#fff">Total limpiezas<br><small style="color:#aac">acumulado</small></td>
      ${totalesHtml}
    </tr>

  </tbody>
</table>

<p class="nota">
  <strong>Nota:</strong> cada fila corresponde a un turno. Las celdas verdes indican que el conserje registró la limpieza de ese portal en el PDF de su parte. Las celdas vacías no significan necesariamente que no se limpió, sino que no se recoge explícitamente en el parte de ese turno.
</p>

</body>
</html>`;
}

// ─── Handler principal ───────────────────────────────────────────────────────

export const handler = async () => {
  console.log('Iniciando actualización de portales...');

  // 1. Autenticar con Gmail API
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth });

  // 2. Obtener el index.html actual de GitHub (necesitamos el SHA para actualizarlo)
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const [owner, repo] = process.env.GITHUB_REPO.split('/');

  let shaActual;
  let htmlActual = '';
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: 'index.html' });
    shaActual = data.sha;
    htmlActual = Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (e) {
    console.log('index.html no encontrado en GitHub, se creará desde cero.');
  }

  // 3. Buscar todos los partes (últimos 90 días para tener histórico completo)
  //    En producción podrías limitar a newer_than:2d y mergear con el HTML existente.
  //    Para simplicidad, regeneramos desde los últimos 90 días cada vez.
  const query = 'from:conserje@ferreryperdomo.com subject:Parte newer_than:90d';
  const listResp = await gmail.users.threads.list({
    userId: 'me',
    q: query,
    maxResults: 200,
  });

  const threads = listResp.data.threads || [];
  console.log(`Encontrados ${threads.length} hilos de partes.`);

  // 4. Procesar cada hilo
  const partes = [];
  for (const thread of threads) {
    const threadData = await gmail.users.threads.get({
      userId: 'me',
      id: thread.id,
      format: 'full',
    });

    // Tomamos solo el primer mensaje del hilo (evita duplicados de reenvíos)
    const msg = threadData.data.messages[0];
    const headers = msg.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const dateStr = headers.find(h => h.name === 'Date')?.value || '';
    const fecha = new Date(dateStr);

    // Extraer conserje y turno del asunto
    // Formato: "Parte de 2026-05-18 de Juan Antonio No laborables tarde"
    const matchAsunto = subject.match(/Parte de [\d-]+ de (.+)/);
    if (!matchAsunto) continue;

    const resto = matchAsunto[1].trim();

    // Los conserjes conocidos (en orden de longitud desc para evitar match parcial)
    const conserjesConocidos = ['Juan Antonio', 'Juan Manuel', 'Carmelo', 'Ruymán'];
    let conserje = null;
    let turno = resto;
    for (const c of conserjesConocidos) {
      if (resto.startsWith(c)) {
        conserje = c;
        turno = resto.slice(c.length).trim();
        break;
      }
    }
    if (!conserje) continue;

    // Buscar el PDF adjunto
    let textoPdf = '';
    const partes2 = msg.payload.parts || [];
    const buscarPdf = (parts) => {
      for (const part of parts) {
        if (part.mimeType === 'application/pdf' && part.body?.attachmentId) {
          return part.body.attachmentId;
        }
        if (part.parts) {
          const found = buscarPdf(part.parts);
          if (found) return found;
        }
      }
      return null;
    };

    const attachmentId = buscarPdf(partes2);
    if (attachmentId) {
      textoPdf = await descargaYLeePdf(gmail, msg.id, attachmentId);
    }

    const portalesLimpios = extraePortales(textoPdf);

    partes.push({ fecha, conserje, turno, portalesLimpios });
  }

  // 5. Ordenar por fecha ascendente
  partes.sort((a, b) => a.fecha - b.fecha);

  // 6. Generar filas y calcular totales
  const filas = [];
  const totales = {};
  for (let p = 26; p <= 33; p++) totales[p] = 0;

  for (const parte of partes) {
    filas.push(generaFila(parte.fecha, parte.turno, parte.conserje, parte.portalesLimpios));
    for (const p of parte.portalesLimpios) {
      if (p >= 26 && p <= 33) totales[p]++;
    }
  }

  // 7. Generar HTML completo
  const fechaActualizacion = new Date().toLocaleDateString('es-ES', {
    timeZone: 'Atlantic/Canary',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const nuevoHtml = generaHtml(filas, totales, fechaActualizacion);

  // 8. Subir a GitHub solo si hay cambios
  if (nuevoHtml === htmlActual) {
    console.log('Sin cambios, no se actualiza GitHub.');
    return { statusCode: 200, body: 'Sin cambios.' };
  }

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: 'index.html',
    message: `Actualización automática ${fechaActualizacion}`,
    content: Buffer.from(nuevoHtml).toString('base64'),
    sha: shaActual,
  });

  console.log('index.html actualizado en GitHub correctamente.');
  return { statusCode: 200, body: 'Actualizado correctamente.' };
};
