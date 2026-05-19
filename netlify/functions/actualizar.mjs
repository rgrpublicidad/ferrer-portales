/**
 * Netlify Scheduled Function - Actualización diaria de limpieza de portales
 * Edificio Ferrer y Perdomo (Las Palmas de Gran Canaria)
 *
 * Se ejecuta cada día a las 7:00 UTC (8:00 hora Canarias invierno / 8:00 verano)
 * Lee los partes de conserje@ferreryperdomo.com, extrae los portales limpiados
 * del PDF adjunto, y AÑADE solo las filas nuevas al index.html en GitHub.
 * NUNCA borra ni modifica filas existentes.
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
  if ((t.includes('lunes') || t.includes('viernes')) && t.includes('mañana')) return 'L-V mañana';
  if ((t.includes('lunes') || t.includes('viernes')) && t.includes('tarde'))  return 'L-V tarde';
  if (t.includes('laborables') && t.includes('mañana')) return 'No lab. mañana';
  if (t.includes('laborables') && t.includes('tarde'))  return 'No lab. tarde';
  return turno;
}

/**
 * Extrae qué portales (26-33) aparecen mencionados como limpios en el texto del PDF.
 * Usa múltiples patrones para cubrir las distintas formas de escritura de los conserjes.
 */
function extraePortales(texto) {
  const portalesLimpios = new Set();
  const textoNorm = texto.toLowerCase();

  // Patrón 1: "portal(es) n? XX" — cubre "portal 26", "portal n 26", "portales 26, 27"
  const patron1 = /portales?\s+(?:n[°º.]?\s*)?(\d[\d\s,yY]*)/g;
  let m;
  while ((m = patron1.exec(textoNorm)) !== null) {
    const numeros = m[1].match(/\d+/g) || [];
    for (const n of numeros) {
      const num = parseInt(n);
      if (num >= 26 && num <= 33) portalesLimpios.add(num);
    }
  }

  // Patrón 2: "limpio/barrió/fregó el portal n? XX"
  const patron2 = /(?:limpi(?:o|é|a|ó)|barri(?:ó|o)|freg(?:ó|o)|lav(?:ó|o))\s+(?:el\s+)?portal\s+(?:n[°º.]?\s*)?(\d+)/g;
  while ((m = patron2.exec(textoNorm)) !== null) {
    const num = parseInt(m[1]);
    if (num >= 26 && num <= 33) portalesLimpios.add(num);
  }

  // Patrón 3: "se limpió el portal n XX" (forma pasiva)
  const patron3 = /se\s+limpi(?:o|ó)\s+(?:el\s+)?portal\s+(?:n[°º.]?\s*)?(\d+)/g;
  while ((m = patron3.exec(textoNorm)) !== null) {
    const num = parseInt(m[1]);
    if (num >= 26 && num <= 33) portalesLimpios.add(num);
  }

  // Patrón 4: cualquier número 26-33 precedido de "portal" con hasta 5 chars entre medio
  const patron4 = /portal[^\d]{0,5}(\d+)/g;
  while ((m = patron4.exec(textoNorm)) !== null) {
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

/**
 * Extrae las claves "DD/MM-turnoCorto" de las filas ya existentes en el HTML.
 * Así sabemos qué partes ya están registrados y no los volvemos a añadir.
 */
function extraeFilasExistentes(html) {
  const existentes = new Set();
  // Busca patrones como: "Lun 18/05" y "L-V mañana" dentro de cada <tr>
  const patronFila = /semana-label[^>]*>([^<]+)<\/span><br><small>([^<]+)<\/small>/g;
  let m;
  while ((m = patronFila.exec(html)) !== null) {
    // m[1] = "Lun 18/05", m[2] = "L-V mañana"
    // Extraemos solo DD/MM del label
    const fechaMatch = m[1].match(/(\d{2}\/\d{2})/);
    if (fechaMatch) {
      existentes.add(`${fechaMatch[1]}-${m[2].trim()}`);
    }
  }
  return existentes;
}

/**
 * Recalcula los totales leyendo el HTML completo (filas existentes + nuevas).
 * Parsea cada <tr> que no sea de totales ni de cabecera, y cuenta las celdas limpio
 * por posición (columna 1 = portal 26, columna 2 = portal 27, etc.)
 */
function recalculaTotales(html) {
  const totales = {};
  for (let p = 26; p <= 33; p++) totales[p] = 0;

  // Extraer todas las filas de datos (excluir thead y fila de totales)
  const patronFila = /<tr(?!\s*class="totales")>([\s\S]*?)<\/tr>/g;
  let fila;
  while ((fila = patronFila.exec(html)) !== null) {
    const contenido = fila[1];
    // Ignorar filas de cabecera (contienen <th)
    if (contenido.includes('<th')) continue;
    // Ignorar fila de totales
    if (contenido.includes('Total limpiezas')) continue;

    // Extraer todas las <td> de esta fila
    const celdas = [];
    const patronCelda = /<td([^>]*)>([\s\S]*?)<\/td>/g;
    let celda;
    while ((celda = patronCelda.exec(contenido)) !== null) {
      celdas.push(celda[1]); // guardamos los atributos de la td
    }

    // La primera td es la fecha, las siguientes son portales 26-33
    const portales = [26, 27, 28, 29, 30, 31, 32, 33];
    for (let i = 0; i < portales.length; i++) {
      const atributos = celdas[i + 1] || '';
      if (atributos.includes('limpio')) {
        totales[portales[i]]++;
      }
    }
  }
  return totales;
}

/**
 * Inserta nuevas filas ANTES de la fila de totales en el HTML existente,
 * y actualiza la fila de totales con los nuevos recuentos.
 */
function insertaFilasEnHtml(htmlActual, filasNuevas, fechaActualizacion) {
  if (filasNuevas.length === 0) return htmlActual;

  const filasHtml = filasNuevas.join('\n');

  // Insertar antes de la fila de totales
  const marcador = '<tr class="totales">';
  if (!htmlActual.includes(marcador)) {
    console.log('No se encontró la fila de totales en el HTML existente.');
    return htmlActual;
  }

  let nuevoHtml = htmlActual.replace(marcador, filasHtml + '\n\n    ' + marcador);

  // Recalcular totales
  const totales = recalculaTotales(nuevoHtml);
  const totalesHtml = [26, 27, 28, 29, 30, 31, 32, 33]
    .map(p => `<td>${totales[p] || 0}</td>`)
    .join('\n      ');

  // Reemplazar la fila de totales completa
  nuevoHtml = nuevoHtml.replace(
    /<tr class="totales">[\s\S]*?<\/tr>/,
    `<tr class="totales">
      <td class="col-fecha" style="color:#fff">Total limpiezas<br><small style="color:#aac">acumulado</small></td>
      ${totalesHtml}
    </tr>`
  );

  // Actualizar fecha de actualización
  nuevoHtml = nuevoHtml.replace(
    /Actualizado: [\d\/]+(?: \(auto\))?/,
    `Actualizado: ${fechaActualizacion} (auto)`
  );

  return nuevoHtml;
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

  // 2. Obtener el index.html actual de GitHub
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const [owner, repo] = process.env.GITHUB_REPO.split('/');

  let shaActual;
  let htmlActual = '';
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: 'index.html' });
    shaActual = data.sha;
    htmlActual = Buffer.from(data.content, 'base64').toString('utf-8');
    console.log('HTML actual obtenido de GitHub.');
  } catch (e) {
    console.log('index.html no encontrado en GitHub.');
    return { statusCode: 500, body: 'No se encontró index.html en GitHub.' };
  }

  // 3. Extraer qué filas ya existen para no duplicarlas
  const filasExistentes = extraeFilasExistentes(htmlActual);
  console.log(`Filas ya existentes en el HTML: ${filasExistentes.size}`);

  // 4. Buscar partes de los últimos 3 días en Gmail
  const query = 'from:conserje@ferreryperdomo.com subject:Parte newer_than:3d';
  const listResp = await gmail.users.threads.list({
    userId: 'me',
    q: query,
    maxResults: 50,
  });

  const threads = listResp.data.threads || [];
  console.log(`Encontrados ${threads.length} hilos de partes recientes.`);

  // 5. Procesar cada hilo y filtrar los que ya están en el HTML
  const partesNuevos = [];
  for (const thread of threads) {
    const threadData = await gmail.users.threads.get({
      userId: 'me',
      id: thread.id,
      format: 'full',
    });

    const msg = threadData.data.messages[0];
    const headers = msg.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const dateStr = headers.find(h => h.name === 'Date')?.value || '';
    const fecha = new Date(dateStr);

    console.log(`  Asunto: "${subject}"`);
    const matchAsunto = subject.match(/Parte de [\d-]+ de (.+)/);
    if (!matchAsunto) { console.log('  → No coincide con el patrón, se descarta.'); continue; }

    const resto = matchAsunto[1].trim();
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
    if (!conserje) { console.log('  → Conserje no reconocido, se descarta.'); continue; }

    const turnoCorto = normalizaTurno(turno);
    const dd = fechaCorta(fecha);
    const clave = `${dd}-${turnoCorto}`;

    if (filasExistentes.has(clave)) {
      console.log(`  → ${clave} ya existe en el HTML, se omite.`);
      continue;
    }

    console.log(`  → NUEVO: ${clave} de ${conserje}`);

    // Buscar el PDF adjunto
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

    const partes2 = msg.payload.parts || [];
    const attachmentId = buscarPdf(partes2);
    let textoPdf = '';
    if (attachmentId) {
      textoPdf = await descargaYLeePdf(gmail, msg.id, attachmentId);
    }

    const portalesLimpios = extraePortales(textoPdf);
    console.log(`  → Portales detectados: ${[...portalesLimpios].join(', ') || 'ninguno'}`);

    partesNuevos.push({ fecha, conserje, turno, portalesLimpios });
  }

  if (partesNuevos.length === 0) {
    console.log('No hay partes nuevos que añadir.');
    return { statusCode: 200, body: 'Sin cambios.' };
  }

  // 6. Ordenar los nuevos por fecha ascendente y generar sus filas
  partesNuevos.sort((a, b) => a.fecha - b.fecha);
  const filasNuevas = partesNuevos.map(p =>
    generaFila(p.fecha, p.turno, p.conserje, p.portalesLimpios)
  );

  // 7. Insertar filas nuevas en el HTML existente (nunca borra lo anterior)
  const fechaActualizacion = new Date().toLocaleDateString('es-ES', {
    timeZone: 'Atlantic/Canary',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const nuevoHtml = insertaFilasEnHtml(htmlActual, filasNuevas, fechaActualizacion);

  // 8. Subir a GitHub
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: 'index.html',
    message: `Actualización automática ${fechaActualizacion} (+${partesNuevos.length} partes)`,
    content: Buffer.from(nuevoHtml).toString('base64'),
    sha: shaActual,
  });

  console.log(`index.html actualizado en GitHub con ${partesNuevos.length} partes nuevos.`);
  return { statusCode: 200, body: `Añadidos ${partesNuevos.length} partes nuevos.` };
};
