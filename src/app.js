// Mejora en el manejo del menú del día y solución para usuarios concurrentes + MÚLTIPLES PEDIDOS
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import { join } from "path";
import {
  createBot,
  createProvider,
  createFlow,
  addKeyword,
  utils,
  EVENTS,
} from "@builderbot/bot";
// import { MysqlAdapter as Database } from "@builderbot/database-mysql";
import { JsonFileDB as Database } from '@builderbot/database-json'
// import { BaileysProvider  as Provider } from "@builderbot/provider-baileys";
import { WPPConnectProvider as Provider } from "@builderbot/provider-wppconnect";
import axios from "axios";
import { idleFlow, start, reset, stop } from "./idle-custom.js";

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { TIMEOUT } from "dns";
// import { ref } from "process";
dotenv.config();
// Configuración
const IMAGE_CACHE_DIR = "./.tmp_images";
const IMAGE_TIMEOUT_MS = parseInt(process.env.IMAGE_TIMEOUT_MS) || 15000;
const CONCURRENT_DOWNLOADS = parseInt(process.env.CONCURRENT_DOWNLOADS) || 3;
const PORT = process.env.BOT_PORT || process.env.PORT;
// AGREGAR ESTAS NUEVAS LÍNEAS:
const API_BASE_URL = process.env.API_BASE_URL;
const API_TIMEOUT = parseInt(process.env.API_TIMEOUT);
// Crear directorio temporal si no existe
if (!fs.existsSync(IMAGE_CACHE_DIR)) {
  fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
}

const pedidosPendientes = new Map();

// Semáforo simple para limitar descargas concurrentes
class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.waiting = [];
  }

  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release() {
    this.count--;
    if (this.waiting.length > 0 && this.count < this.max) {
      this.count++;
      const next = this.waiting.shift();
      next();
    }
  }
}

const downloadSemaphore = new Semaphore(CONCURRENT_DOWNLOADS);

// Función mejorada para descargar imágenes con control de concurrencia y mejor manejo de errores
// Añadir un sistema de bloqueo para evitar solicitudes concurrentes al menú
let menuRequestInProgress = false;
let menuRequestLock = Promise.resolve();

// Función mejorada para descargar imágenes con mejor manejo de errores
const downloadImage = async (url, filename) => {
  await downloadSemaphore.acquire();
  const filePath = path.join(IMAGE_CACHE_DIR, filename);

  try {
    // Verificar si la URL es válida antes de intentar cualquier operación
    if (
      !url ||
      typeof url !== "string" ||
      url === "null" ||
      url === "undefined"
    ) {
      console.log(`[DOWNLOAD] URL inválida para ${filename}, retornando null`);
      downloadSemaphore.release();
      return null;
    }

    // Verificar si la imagen ya existe en caché
    if (fs.existsSync(filePath)) {
      // Verificar cuándo se creó el archivo
      const stats = fs.statSync(filePath);
      const fileAgeMs = Date.now() - stats.mtimeMs;

      // Si el archivo es más antiguo que el TTL del menú, eliminarlo para forzar descarga nueva
      if (fileAgeMs > MENU_CACHE_TTL) {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (err) {
          if (err.code !== "ENOENT") {
            console.error(
              `Error al eliminar archivo caché antiguo ${filename}:`,
              err.message
            );
          }
        }
      } else {
        downloadSemaphore.release();
        return filePath;
      }
    }

    // Convertir la URL en una URL válida
    // const validUrl = url.startsWith('http') ? url : `http://127.0.0.1:8000/storage/${url}`;
    const validUrl = url.startsWith("http")
      ? url
      : buildApiUrl(`/storage/${url}`);

    // Verificar que la URL es válida antes de hacer la petición
    try {
      new URL(validUrl);
    } catch (e) {
      console.error(`[DOWNLOAD] URL inválida: ${validUrl}`);
      downloadSemaphore.release();
      return null;
    }

    const response = await axios.get(validUrl, {
      responseType: "stream",
      timeout: IMAGE_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300, // Solo aceptar respuestas exitosas
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        writer.close();
        reject(new Error(`Timeout downloading ${filename}`));
      }, IMAGE_TIMEOUT_MS);

      writer.on("finish", () => {
        clearTimeout(timer);
        downloadSemaphore.release();
        resolve(filePath);
      });

      writer.on("error", (err) => {
        clearTimeout(timer);
        downloadSemaphore.release();
        reject(err);
      });
    });
  } catch (error) {
    downloadSemaphore.release();
    console.error(`[DOWNLOAD] Error con ${filename}:`, error.message);
    return null;
  }
};

// Función para verificar si el cliente tiene pagos pendientes
// Función para verificar si el cliente tiene pagos pendientes
const verificarPagoPendiente = async (telefono) => {
  try {
    const pagoUrl = buildApiUrl("/api/verificar-pago");
    const response = await axios.post(pagoUrl, {
      telefono: telefono
    }, {
      timeout: API_TIMEOUT,
    });
    return response.data;
  } catch (error) {
    console.error("Error verificando pago pendiente:", error);
    return { success: false }; // En caso de error, permitir continuar
  }
};


// Api para ver si el bot esta activo
const verificarHorarioActivo = async () => {
  try {
    const horarioUrl = buildApiUrl('/api/bot/configuracion');
    const response = await axios.get(horarioUrl, {
      timeout: API_TIMEOUT,
    });

    return response.data;
  } catch (error) {
    console.error('Error verificando horario:', error);
    // En caso de error, asumimos que el bot está activo para no bloquear el servicio
    return {
      esta_activo: true,
      activo: true,
      hora_inicio: '08:00',
      hora_fin: '22:00'
    };
  }
};
// Agregar esta función después de las demás funciones de utilidad
const calcularHoraEntrega = () => {
  const ahora = new Date();
  const horaActual = ahora.getHours();
  const minutosActual = ahora.getMinutes();

  // Convertir a minutos totales para fácil comparación
  const minutosTotales = horaActual * 60 + minutosActual;

  // Definir el corte para el primer viaje (10:45 AM)
  const cortePrimerViaje = 10 * 60 + 45; // 10:45 en minutos

  if (minutosTotales < cortePrimerViaje) {
    // Pedidos antes de 10:45 AM - entrega entre 11:00 y 12:00
    return "11:00 AM - 12:00 PM";
  } else {
    // Pedidos después de 10:45 AM - entrega entre 12:40 y 1:40 PM
    return "12:30 PM - 12:40 PM";
  }
};


// Función para obtener la fecha de hoy desde el backend
const obtenerFechaHoy = async () => {
  try {

    const fechaUrl = buildApiUrl("/api/fecha-hoy");
    console.log(fechaUrl, "acaaaaaaaaaa")
    const response = await axios.get(fechaUrl, {
      timeout: API_TIMEOUT,
    });
    return response.data.fecha || "Fecha no disponible";
  } catch (error) {
    console.error("Error obteniendo fecha de hoy:", error);
    // Fallback a fecha local si falla la API
    const hoy = new Date();
    return hoy.toLocaleDateString("es-ES", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }
};
// Función para limpiar caché con mejor manejo de errores
const cleanImageCache = () => {
  try {
    if (!fs.existsSync(IMAGE_CACHE_DIR)) return;
    const files = fs.readdirSync(IMAGE_CACHE_DIR);
    files.forEach((file) => {
      try {
        const filePath = path.join(IMAGE_CACHE_DIR, file);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.error(`Error al eliminar archivo ${file}:`, err.message);
        }
      }
    });
  } catch (err) {
    console.error("Error al limpiar caché de imágenes:", err.message);
  }
};

// Cache para el menú por 5 minutos para reducir llamadas a la API
let menuCache = null;
let menuCacheTime = 0;
// const MENU_CACHE_TTL = 0.1 * 60 * 1000
const MENU_CACHE_TTL = 0.1 * 60 * 1000; // 1 minutos

const buildApiUrl = (endpoint) => {
  const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  console.log(`${API_BASE_URL}${cleanEndpoint}`);
  return `${API_BASE_URL}${cleanEndpoint}`;
};

// Función para crear sesión de pago
const crearSesionPago = async (pedidoData, total, pedidoId, pedidos) => {
  // Generar número de factura (puedes usar el pedidoId o generar uno personalizado)
  const numeroFactura = `FAC-${pedidoId || Date.now()}`;

  // Crear desglose detallado de los platillos
  let desglosePlatillos = "";
  if (pedidos && pedidos.length > 0) {
    desglosePlatillos = pedidos
      .map(
        (platillo) =>
          `${platillo.nombre_platillo} x${platillo.cantidad} (Lps ${platillo.precio_platillo} c/u)`
      )
      .join(", ");
  }

  // Descripción detallada
  const descripcionDetallada = `Factura: ${numeroFactura} | Platillos: ${desglosePlatillos} | Total: Lps ${total}`;
  try {
    const paymentData = {
      name: pedidoData.nombre || "Usuario",
      email: "", // Email simulado
      mobile: parseInt(pedidoData.telefono.replace(/\D/g, "")), // Solo números
      description: descripcionDetallada,
      total: total,
      currency: "HNL",
      returnUrl: "https://mi-sitio.com/respuesta-pago",
    };

    const paymentUrl = buildApiUrl("/api/placetopay/session");
    const response = await axios.post(paymentUrl, paymentData, {
      timeout: API_TIMEOUT,
    });

    return response.data;
  } catch (error) {
    console.error("Error creando sesión de pago:", error);
    throw error;
  }
};
// Función para verificar estado del pago
const verificarEstadoPago = async (requestId) => {
  try {
    const statusUrl = buildApiUrl(`/api/placetopay/status/${requestId}`);
    const response = await axios.get(statusUrl, {
      timeout: API_TIMEOUT,
    });
    return response.data;
  } catch (error) {
    console.error("Error verificando estado del pago:", error);
    return { success: false };
  }
};
// 1. AGREGAR esta nueva función después de verificarEstadoPago
const obtenerCotizacion = async (pedidoData) => {
  try {
    const cotizacionUrl = buildApiUrl("/api/cotizar");
    const response = await axios.get(cotizacionUrl, {
      data: pedidoData,
      timeout: API_TIMEOUT,
    });
    return { ...response.data, hora_entrega: calcularHoraEntrega() }
      ;
  } catch (error) {
    console.error("Error obteniendo cotización:", error);
    throw error;
  }
};

// Función para preparar pedido
const prepararPedido = async (pedidoId) => {
  try {
    const prepararUrl = buildApiUrl(`/api/pedido/${pedidoId}/preparar`);
    const response = await axios.post(
      prepararUrl,
      {},
      {
        timeout: API_TIMEOUT,
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error preparando pedido:", error);
    return { success: false };
  }
};

// Función para cancelar pedido
const cancelarPedido = async (pedidoId) => {
  try {
    const cancelarUrl = buildApiUrl(`/api/pedido/${pedidoId}/cancelar`);
    const response = await axios.post(
      cancelarUrl,
      {},
      {
        timeout: API_TIMEOUT,
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error cancelando pedido:", error);
    return { success: false };
  }
};

// 1. FUNCIÓN PARA LIMPIAR ESTADO COMPLETO
const limpiarEstadoCompleto = async (state) => {
  await state.clear(); // Limpia todo el estado
  // O si prefieres ser más específico:
  /*
    await state.update({
        pedidos: [],
        menuData: null,
        pedidoActualId: null,
        pedidoActualBody: null,
        pedidoActualCantidadDisponible: null,
        pedidoActualNombre: null,
        pedidoActualPrecio: null,
        cantidadActual: null,
        ubicacion: null,
        costoEnvio: 0,
        distanciaKm: 0,
        tiempoMin: 0,
        subtotal: 0,
        totalConEnvio: 0
    })
    */
};
// 2. FUNCIÓN MEJORADA PARA VERIFICAR CANCELACIÓN CON LIMPIEZA DE ESTADO

const verificarCancelacion = async (ctx, state) => {
  const mensaje = ctx.body
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (["cancelar", "cancel", "salir", "terminar"].includes(mensaje)) {
    // LIMPIAR TODO EL ESTADO ANTES DE TERMINAR
    await limpiarEstadoCompleto(state);
    return true;
  }
  return false;
};

// Versión mejorada del menuAPI con sistema de bloqueo
const menuAPI = async () => {
  // Si ya hay una solicitud en progreso, esperar a que termine
  if (menuRequestInProgress) {
    await menuRequestLock;

    // Después de esperar, si el caché es reciente, usar el caché
    const now = Date.now();
    if (menuCache && now - menuCacheTime < MENU_CACHE_TTL) {
      console.log("[MENU] Usando caché después de esperar solicitud anterior");
      return structuredClone(menuCache); // Usar copia profunda para evitar modificaciones
    }
  }

  // Crear nueva promesa para el bloqueo
  let unlockRequest;
  menuRequestLock = new Promise((resolve) => {
    unlockRequest = resolve;
  });

  menuRequestInProgress = true;

  try {
    // Usar caché si está disponible y es reciente
    const now = Date.now();
    if (menuCache && now - menuCacheTime < MENU_CACHE_TTL) {
      console.log("[MENU] Usando caché reciente");
      return structuredClone(menuCache); // Usar copia profunda para evitar modificaciones
    }

    console.log("[MENU] Obteniendo nuevo menú de la API");
    // const response = await axios.get('http://127.0.0.1:8000/admin/menu/MenuHoy', {
    //     timeout: API_TIMEOUT // 10 segundos máximo para la API
    // });
    const menuUrl = buildApiUrl("/admin/menu/MenuHoy");

    const response = await axios.get(menuUrl, {
      timeout: API_TIMEOUT, // 10 segundos máximo para la API
    });
    if (
      !response.data ||
      !response.data.menu ||
      !Array.isArray(response.data.menu)
    ) {
      console.error("[MENU] Respuesta de API inválida:", response.data);
      throw new Error("Formato de respuesta inválido");
    }

    const menu = response.data.menu.map((item) => {
      // Verificar que la imagen_url sea válida
      let imagen_url = item.imagen_url;
      let imagen_filename = null;

      if (imagen_url && imagen_url !== "null" && imagen_url !== "undefined") {
        try {
          // Verificar si es una URL válida
          // new URL(imagen_url.startsWith('http') ? imagen_url : `http://127.0.0.1:8000/storage/${imagen_url}`);
          const fullImageUrl = imagen_url.startsWith("http")
            ? imagen_url
            : buildApiUrl(`/storage/${imagen_url}`);
          new URL(fullImageUrl);
          imagen_filename = `${item.id}_${path.basename(imagen_url)}`;
        } catch (e) {
          console.error(
            `[MENU] URL inválida para platillo ${item.id}:`,
            imagen_url
          );
          imagen_url = null;
          imagen_filename = null;
        }
      } else {
        imagen_url = null;
      }

      return {
        id: item.id,
        cantidad_patillo: item.cantidad_disponible || 0,
        nombre_platillo: item.nombre || "Platillo sin nombre",
        precio_platillo: item.precio_base || 0,
        imagen_url: imagen_url,
        imagen_filename: imagen_filename,
        body: `🍽️ ${item.nombre || "Platillo sin nombre"}\n💵 Precio: Lps ${item.precio_base || 0
          }\n📦 ${item.cantidad_disponible > 0
            ? "Platillo *Disponible*"
            : "*Platillo agotado*"
          }\n📝 Descripción: ${item.descripcion || "Sin descripción"}`,
      };
    });

    // Actualizar caché con copia profunda para evitar modificaciones accidentales
    menuCache = structuredClone(menu);
    menuCacheTime = now;

    return structuredClone(menu); // Retornar copia para evitar modificaciones
  } catch (error) {
    console.error("[MENU] Error al obtener el menú:", error.message);
    //  return menuCache || []; 

  } finally {
    // Liberar el bloqueo
    menuRequestInProgress = false;
    unlockRequest();
  }
};

// NUEVA FUNCIÓN: Mostrar resumen del carrito
const mostrarResumenCarrito = (pedidos) => {
  if (!pedidos || pedidos.length === 0) {
    return "🛒 *Tu carrito está vacío*";
  }

  let resumen = "🛒 *RESUMEN DE TU CARRITO:*\n━━━━━━━━━━━━━━━━━━\n";
  let subtotal = 0;

  pedidos.forEach((pedido, index) => {
    const totalPlatillo = pedido.precio_platillo * pedido.cantidad;
    subtotal += totalPlatillo;
    resumen += `${index + 1}. ${pedido.nombre_platillo}\n`;
    resumen += `   Cantidad: ${pedido.cantidad} x Lps ${pedido.precio_platillo} = Lps ${totalPlatillo}\n\n`;
  });

  resumen += `━━━━━━━━━━━━━━━━━━\n💰 *Subtotal: Lps ${subtotal}*\n`;
  resumen += `🚚 (El costo de envío se calculará al finalizar)`;

  return resumen;
};

// Flujo de pedido mejorado con soporte para múltiples pedidos Y carrito
const flowPedido = addKeyword(["__Flujo De Pedido Completo__"])
  .addAnswer(
    "📝 *Selecciona un platillo:*\n\n" +
    "Escribe solo el *número* del platillo que deseas:\n\n",
    { capture: true },
    async (ctx, { state, fallBack, flowDynamic, gotoFlow, endFlow }) => {
      if (await verificarCancelacion(ctx, state)) {
        stop(ctx);
        return endFlow(
          "❌ *Operación cancelada*\n\nSi deseas hacer un pedido nuevamente, escribe *HOLA* 👋"
        );
      }

      try {
        reset(ctx, gotoFlow, 600000);
        const menu = await menuAPI();

        if (!menu || menu.length === 0) {
          stop(ctx);
          return endFlow(
            '⚠️ El menú de hoy ha sido modificado o eliminado. Por favor, escribe "hola" para comenzar de nuevo.'
          );
        }

        await state.update({ menu });
        const choice = parseInt(ctx.body);

        if (isNaN(choice) || choice < 1 || choice > menu.length) {
          return fallBack(
            "❌ Opción inválida. Por favor, escribe un número válido:"
          );
        }

        const pedido = menu[choice - 1];

        if (pedido.cantidad_patillo === 0) {
          return fallBack(`*PLATILLO AGOTADO*
El platillo que seleccionaste (${pedido.nombre_platillo}) ya no está disponible.
🔄 Por favor elige otro platillo de la lista`);
        }

        await state.update({
          pedidoActualId: pedido.id,
          pedidoActualBody: pedido.body,
          pedidoActualCantidadDisponible: pedido.cantidad_patillo,
          pedidoActualNombre: pedido.nombre_platillo,
          pedidoActualPrecio: pedido.precio_platillo,
        });
      } catch (error) {
        console.error("Error en selección de platillo:", error);
        stop(ctx);
        return endFlow(
          "❌ Ocurrió un error. Intenta de nuevo escribiendo *HOLA*"
        );
      }
    }
  )
  .addAnswer(null, async (ctx, { state, flowDynamic }) => {
    const { pedidoActualBody } = state.getMyState();
    await flowDynamic(`✅ Has seleccionado: ${pedidoActualBody}`);
  })
  .addAnswer(
    "🔢 ¿Cuántas unidades deseas pedir?",
    { capture: true },
    async (ctx, { state, fallBack, endFlow, gotoFlow }) => {
      try {
        if (await verificarCancelacion(ctx, state)) {
          stop(ctx);
          return endFlow(
            "❌ *Operación cancelada*\n\nSi deseas hacer un pedido nuevamente, escribe *HOLA* 👋"
          );
        }

        reset(ctx, gotoFlow, 600000);
        const myState = state.getMyState();
        const cantidad = parseInt(ctx.body);

        if (isNaN(cantidad)) {
          return fallBack("❌ Por favor, ingresa un número válido:");
        }

        if (cantidad <= 0) {
          return fallBack(
            "❌ La cantidad debe ser mayor a 0. Por favor, ingresa una cantidad válida:"
          );
        }

        if (cantidad > myState.pedidoActualCantidadDisponible) {
          return fallBack(
            `❌ No hay suficiente disponibilidad. Solo quedan ${myState.pedidoActualCantidadDisponible} unidades. Por favor, ingresa una cantidad menor:`
          );
        }

        await state.update({ cantidadActual: cantidad });
      } catch (error) {
        console.error("Error en cantidad de pedido:", error);
        stop(ctx);
        return endFlow(
          "❌ Ocurrió un error. Intenta de nuevo escribiendo *HOLA*"
        );
      }
    }
  )
  .addAnswer(
    "✅ *Platillo agregado al carrito*",
    null,
    async (ctx, { state, flowDynamic }) => {
      const myState = state.getMyState();

      // Inicializar array de pedidos si no existe
      let pedidos = myState.pedidos || [];

      // Agregar el pedido actual al array
      const nuevoPedido = {
        id: myState.pedidoActualId,
        nombre_platillo: myState.pedidoActualNombre,
        precio_platillo: myState.pedidoActualPrecio,
        cantidad: myState.cantidadActual,
      };

      pedidos.push(nuevoPedido);

      // Actualizar estado con el array de pedidos
      await state.update({ pedidos });

      // Mostrar resumen del carrito
      const resumenCarrito = mostrarResumenCarrito(pedidos);
      await flowDynamic(resumenCarrito);
    }
  )
  .addAnswer(
    "🛒 ¿Deseas agregar otro platillo a tu pedido?\n\n" +
    "Responde:\n" +
    "• *sí* - Para agregar otro platillo\n" +
    "• *no* - Para continuar con el pedido",
    { capture: true },
    async (ctx, { fallBack, gotoFlow, endFlow, state }) => {
      if (await verificarCancelacion(ctx, state)) {
        stop(ctx);
        return endFlow(
          "❌ *Operación cancelada*\n\nSi deseas hacer un pedido nuevamente, escribe *HOLA* 👋"
        );
      }

      const respuesta = ctx.body
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      if (respuesta === "si") {
        reset(ctx, gotoFlow, 600000);
        // Volver al inicio del flujo de pedido para seleccionar otro platillo
        return gotoFlow(flowPedido);
      } else if (respuesta === "no") {
        reset(ctx, gotoFlow, 600000);
        // Continuar con el proceso de ubicación y finalización
        return; // Continúa al siguiente paso
      } else {
        return fallBack("❌ Por favor responde únicamente con *sí* o *no*.");
      }
    }
  )
  // NUEVO: SELECCIÓN DE TIPO DE ENTREGA
  .addAnswer(
    "🏠 *SELECCIÓN DE TIPO DE ENTREGA*\n\n" +
    "¿Dónde deseas recibir tu pedido?\n\n" +
    "1️⃣ *Domicilio* - Te lo llevamos a tu ubicación\n" +
    "2️⃣ *Local* - Recógelo en nuestro restaurante",
    { capture: true },
    async (ctx, { fallBack, state, gotoFlow, endFlow }) => {
      if (await verificarCancelacion(ctx, state)) {
        stop(ctx);
        return endFlow("❌ *Operación cancelada*");
      }

      const opcion = ctx.body.trim();
      if (opcion === '1') {
        await state.update({
          domicilio: true,
          tipoEntrega: 'domicilio'
        });
      } else if (opcion === '2') {
        await state.update({
          domicilio: false,
          tipoEntrega: 'local',
          // Coordenadas del restaurante
          ubicacion: {
            latitud: 14.107193046832785,
            longitud: -87.1824026712528
          }
        });

        // Para local, saltar directamente a pedir notas
        return gotoFlow(flowNotas);
      } else {
        return fallBack("❌ Opción inválida. Responde con *1* para Domicilio o *2* para Local");
      }
    }
  )
  // SOLO PARA DOMICILIO - CAPTURAR UBICACIÓN
  .addAnswer(
    "📍 *Por favor, comparte tu ubicación* 📍\n\n" +
    "Usa la función de WhatsApp:\n" +
    "📎 *Adjuntar* → *Ubicación* → *Enviar tu ubicación actual*",
    { capture: true },
    async (ctx, { state, fallBack, gotoFlow, endFlow }) => {
      if (await verificarCancelacion(ctx, state)) {
        stop(ctx);
        return endFlow("❌ *Operación cancelada*");
      }

      try {
        reset(ctx, gotoFlow, 600000);

        if (ctx.type !== "location" || !ctx.lat || !ctx.lng) {
          return fallBack(
            "❌ Por favor, usa el menú de *Adjuntar → Ubicación* para compartir tu ubicación real."
          );
        }

        await state.update({
          ubicacion: {
            latitud: ctx.lat,
            longitud: ctx.lng,
            timestamp: ctx.timestamp,
          },
        });

        // Después de capturar ubicación, ir a notas
        return gotoFlow(flowNotas);
      } catch (error) {
        console.error("Error procesando ubicación:", error);
        stop(ctx);
        return fallBack(
          "❌ Error al procesar tu ubicación. Por favor, inténtalo de nuevo."
        );
      }
    }
  );

// FLUJO DE NOTAS - COMÚN PARA DOMICILIO Y LOCAL
// FLUJO DE NOTAS - COMÚN PARA DOMICILIO Y LOCAL
const flowNotas = addKeyword(["__capturar_notas__"])
  .addAnswer(
    "📝 *NOTAS ESPECIALES*\n\n" +
    "¿Tienes alguna indicación especial para tu pedido?\n\n" +
    "Por ejemplo:\n" +
    "• \"Sin cebolla\"\n" +
    "• \"Poco picante\"\n" +
    "• \"Bien cocido\"\n" +
    "• \"Sin sal\"\n" +
    "• \"Extra salsa\"\n" +
    "• \"Para llevar\"\n\n" +
    "Si no tienes notas especiales, escribe \"no\" o \"ninguna\"",
    { capture: true },
    async (ctx, { state, fallBack, gotoFlow, endFlow }) => {
      if (await verificarCancelacion(ctx, state)) {
        stop(ctx);
        return endFlow("❌ *Operación cancelada*");
      }

      const notas = ctx.body.trim();

      // Si el usuario escribe "no", "ninguna", "nada", etc., guardar como string vacío
      const respuesta = notas.normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      if (["no", "ninguna", "nada", "no hay", "sin notas", "ninguno", "no gracias"].includes(respuesta)) {
        await state.update({ notas: "" });
      } else {
        await state.update({ notas: notas });
      }

      reset(ctx, gotoFlow, 600000);
    }
  )
  // CONTINUAR CON EL PROCESO DE COTIZACIÓN (FLUJO ORIGINAL)
  .addAnswer(
    "🚚 Generando cotización de tu pedido...",
    null,
    async (ctx, { flowDynamic, state, fallBack, gotoFlow }) => {
      try {
        const myState = state.getMyState();
        const nombreUsuario =
          ctx?.notification?.name ||
          ctx?.sender?.pushname ||
          ctx?.pushName ||
          "Usuario";

        // Mostrar resumen final del carrito antes de la cotización
        // const resumenFinalCarrito = mostrarResumenCarrito(myState.pedidos);
        // await flowDynamic(resumenFinalCarrito);

        // Preparar datos para la cotización (INCLUYENDO DOMICILIO Y NOTAS)
        const cotizacionData = {
          nombre: nombreUsuario,
          telefono: ctx.from,
          latitud: myState.ubicacion.latitud,
          longitud: myState.ubicacion.longitud,
          domicilio: myState.domicilio,
          notas: myState.notas || "",
          platillos: myState.pedidos.map((pedido) => ({
            id: pedido.id,
            cantidad: pedido.cantidad,
          })),
        };

        // Obtener cotización de la API
        const cotizacion = await obtenerCotizacion(cotizacionData);

        if (!cotizacion.success) {
          throw new Error(cotizacion.mensaje || "Error al obtener cotización");
        }

        // Guardar datos de la cotización en el estado
        await state.update({
          cotizacion: cotizacion,
          totalFinalCotizacion: cotizacion.resumen.total_general,
        });

        // Generar resumen detallado basado en la cotización
        let resumenDetallado = `📊 *COTIZACIÓN DE TU PEDIDO*\n━━━━━━━━━━━━━━━━━━\n`;
        resumenDetallado += `📍 *Tipo de entrega:* ${myState.domicilio ? '🚚 Domicilio' : '🏪 Recoger en local'}\n`;

        if (myState.notas && myState.notas !== "") {
          resumenDetallado += `📝 *Notas:* ${myState.notas}\n`;
        }

        resumenDetallado += `━━━━━━━━━━━━━━━━━━\n`;

        cotizacion.detalle_platillos.forEach((platillo, index) => {
          resumenDetallado += `${index + 1}. ${platillo.nombre}\n`;
          resumenDetallado += `   Cantidad: ${platillo.cantidad} x Lps ${platillo.precio_unitario} = Lps ${platillo.subtotal}\n\n`;
        });
        resumenDetallado += `⏰ *Hora estimada de entrega:* ${cotizacion.hora_entrega}\n\n`;

        resumenDetallado += `━━━━━━━━━━━━━━━━━━\n`;
        resumenDetallado += `💰 Subtotal: Lps ${cotizacion.resumen.total_platillos_con_isv}\n`;

        // Mostrar costo de envío solo para domicilio
        if (myState.domicilio) {
          resumenDetallado += `🚚 Costo de envío: ${cotizacion.resumen.envio === 0
            ? "GRATIS"
            : `Lps ${cotizacion.resumen.envio}`
            }\n`;
        }

        resumenDetallado += `━━━━━━━━━━━━━━━━━━\n`;
        resumenDetallado += `💳 *TOTAL A PAGAR: Lps ${cotizacion.resumen.total_general}*\n━━━━━━━━━━━━━━━━━━`;

        if (myState.domicilio && cotizacion.resumen.envio === 0) {
          resumenDetallado += `\n🎉 ¡Envío gratis!`;
        }

        await flowDynamic(resumenDetallado);
      } catch (error) {
        console.error("Error obteniendo cotización:", error);

        // Fallback: calcular manualmente si falla la cotización
        const myState = state.getMyState();
        const pedidos = myState.pedidos || [];
        const subtotal = pedidos.reduce((total, pedido) => {
          return total + pedido.precio_platillo * pedido.cantidad;
        }, 0);

        await flowDynamic(
          "⚠️ No pudimos obtener la cotización exacta, pero continuaremos con tu pedido."
        );
        await state.update({
          totalFinalCotizacion: subtotal,
          cotizacion: null,
        });
      }
    }
  )
  .addAnswer(
    "💳 *SELECCIÓN DE MÉTODO DE PAGO*\n\n" +
    "¿Cómo deseas pagar?\n\n" +
    "1️⃣ *Tarjeta* - Pago en línea seguro\n" +
    "2️⃣ *Efectivo* - Pago al momento de la entrega\n" +
    "3️⃣ *Transferencia* - Transferencia bancaria",
    { capture: true },
    async (ctx, { fallBack, state, endFlow }) => {


      if (await verificarCancelacion(ctx, state)) {
        stop(ctx);
        return endFlow("❌ *Operación cancelada*");
      }

      const opcion = ctx.body.trim();
      if (opcion === '1') {
        await state.update({ metodoPago: 'tarjeta' });
      } else if (opcion === '2') {
        await state.update({ metodoPago: 'efectivo' });
      } else if (opcion === '3') {
        await state.update({ metodoPago: 'transferencia' });
      }
      else {
        return fallBack("❌ Opción inválida. Responde con *1* para Tarjeta o *2* para Efectivo");
      }
    }
  )
  .addAnswer(
    "¿Confirmas tu pedido completo? (responde *sí* o *no*)",
    { capture: true },
    async (ctx, { fallBack, gotoFlow, endFlow, state, flowDynamic }) => {

      if (await verificarCancelacion(ctx, state)) {
        stop(ctx);
        return endFlow("❌ *Operación cancelada*");
      }

      const respuesta = ctx.body
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      if (respuesta === "si") {
        reset(ctx, gotoFlow, 600000);

        try {
          const myState = state.getMyState();
          const nombreUsuario =
            ctx?.notification?.name ||
            ctx?.sender?.pushname ||
            ctx?.pushName ||
            "Usuario";

          await flowDynamic("🔄 Verificando disponibilidad y registrando pedido...");

          // PRIMERO: Crear el pedido para verificar disponibilidad (INCLUYENDO NUEVOS CAMPOS)
          const pedidoData = {
            nombre: nombreUsuario,
            telefono: ctx.from,
            latitud: myState.ubicacion.latitud,
            longitud: myState.ubicacion.longitud,
            metodo_pago: myState.metodoPago,
            domicilio: myState.domicilio,
            notas: myState.notas || "",
            platillos: myState.pedidos.map((pedido) => ({
              id: pedido.id,
              cantidad: pedido.cantidad,
            })),
          };

          const pedidoUrl = buildApiUrl("/api/bot-pedido");
          const responsePedido = await fetch(pedidoUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(pedidoData),
            timeout: API_TIMEOUT,
          });

          if (!responsePedido.ok) {
            const errorData = await responsePedido.json().catch(() => ({}));
            throw new Error(
              errorData.mensaje ||
              `Error HTTP: ${responsePedido.status} - ${responsePedido.statusText}`
            );
          }

          const dataPedido = await responsePedido.json();

          if (myState.metodoPago === 'efectivo') {
            // Si es efectivo, no generar enlace de pago
            await flowDynamic(
              "✅ *PEDIDO CONFIRMADO - PAGO EN EFECTIVO* 💵\n\n" +
              "Tu pedido ha sido registrado exitosamente.\n" +
              `📋 *Número de pedido:* ${dataPedido.id}\n` +
              `📍 *Tipo de entrega:* ${myState.domicilio ? '🚚 Domicilio' : '🏪 Recoger en local'}\n` +
              (myState.notas && myState.notas !== "" ? `📝 *Notas:* ${myState.notas}\n\n` : '\n') +
              `💰 *Total a pagar: Lps ${dataPedido.total}*\n\n` +
              "💵 Pagarás en efectivo al momento de la entrega.\n\n" +
              "📞 Te contactaremos pronto para coordinar la entrega.\n\n" +
              "¡Gracias por tu compra! 🍽️"
            );
            // Limpiar estado y terminar
            await limpiarEstadoCompleto(state);
            stop(ctx);
            return endFlow()
          }
          if (myState.metodoPago === 'transferencia') {
            // Si es transferencia, mostrar números de cuenta
            await flowDynamic(
              "✅ *PEDIDO CONFIRMADO - PAGO POR TRANSFERENCIA* 🏦\n\n" +
              "Tu pedido ha sido registrado exitosamente.\n" +
              `📋 *Número de pedido:* ${dataPedido.id}\n` +
              `📍 *Tipo de entrega:* ${myState.domicilio ? '🚚 Domicilio' : '🏪 Recoger en local'}\n` +
              (myState.notas && myState.notas !== "" ? `📝 *Notas:* ${myState.notas}\n\n` : '\n') +
              `💳 *Total a transferir: Lps ${dataPedido.total}*\n\n` +
              "💰 *Realiza tu transferencia a una de nuestras cuentas:*\n\n" +
              "🏦 *Banco Atlántida*\n" +
              "A nombre: Comercial Arsil\n" +
              "Cuenta: 010111018544\n\n" +
              "🏦 *BAC*\n" +
              "A nombre: Deanira Jeaneth Silva Ramos\n" +
              "Cuenta: 747988621\n\n" +
              "🏦 *Banco Ficohsa*\n" +
              "A nombre: Mariela Ardón Silva\n" +
              "Cuenta: 200007361008\n\n" +
              "🏦 *Banco Davivienda*\n" +
              "A nombre: Allan Ardón Silva\n" +
              "Cuenta: 5070191056\n\n" +
              "🏦 *Banco Lafise*\n" +
              "A nombre: Allan Ardón Silva\n" +
              "Cuenta: 114504015354\n\n" +
              "📞 *Después de realizar la transferencia, muestra el comprobante ya sea al dueño o repartidor*\n\n" +
              `⚠️ *Incluye el número de pedido (${dataPedido.id}) en el concepto de la transferencia*\n\n` +
              "¡Gracias por tu compra! 🍽️"
            );

            // Limpiar estado y terminar
            await limpiarEstadoCompleto(state);
            stop(ctx);
            return endFlow()
          }
          console.log("Pedido creado:", dataPedido);

          if (!dataPedido.success) {
            throw new Error(dataPedido.mensaje || "Error al registrar el pedido");
          }

          // Guardar el ID del pedido en el estado
          await state.update({
            pedidoId: dataPedido.id,
            totalFinal: dataPedido.total,
          });

          await flowDynamic(
            "✅ Pedido registrado correctamente. Generando enlace de pago..."
          );

          // SEGUNDO: Generar enlace de pago
          const sesionPago = await crearSesionPago(
            pedidoData,
            dataPedido.total,
            dataPedido.id,
            myState.pedidos
          );

          if (sesionPago.success) {
            await state.update({
              requestId: sesionPago.requestId,
              reference: sesionPago.reference,
            });

            pedidosPendientes.set(ctx.from, {
              requestId: sesionPago.requestId,
              processUrl: sesionPago.processUrl,
              pedidoId: dataPedido.id,
              telefono: ctx.from,
              reference: sesionPago.reference,
              total: dataPedido.total,
            });

            const pagoupdateURL = buildApiUrl(
              `/api/pagos/actualizar/${dataPedido.id}`
            );

            const payload = {
              request_id: sesionPago.requestId,
              referencia_transaccion: sesionPago.reference,
            };

            try {
              const response = await fetch(pagoupdateURL, {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
              });

              const result = await response.json();

              if (response.ok) {
                console.log("Actualización exitosa:", result);
              } else {
                console.error("Error al actualizar pago:", result);
              }
            } catch (error) {
              console.error("Error en la solicitud:", error);
            }

            await flowDynamic(
              `💳 *ENLACE DE PAGO GENERADO*\n\n` +
              `Para completar tu pedido, realiza el pago haciendo clic en este enlace:\n\n` +
              `🔗 ${sesionPago.processUrl}\n\n` +
              `💰 Total a pagar: Lps ${dataPedido.total}\n\n` +
              `⏰ Verificaremos tu pago automáticamente...`
            );

            await flowDynamic("🔍 Verificando el estado de tu pago...");
            stop(ctx);
            return endFlow();
          } else {
            // Si no se pudo generar el pago, cancelar el pedido
            await cancelarPedido(dataPedido.id);
            throw new Error("No se pudo generar el enlace de pago");
          }
        } catch (error) {
          console.error("Error en el proceso de pedido:", error);

          // Si ya se creó un pedido, intentar cancelarlo
          const myState = state.getMyState();
          if (myState.pedidoId) {
            await cancelarPedido(myState.pedidoId);
          }

          let mensajeError = "❌ Error al procesar tu pedido.";

          if (
            error.message &&
            error.message.includes("ya no hay platos disponibles")
          ) {
            mensajeError =
              "❌ Lo sentimos, algunos platillos de tu pedido ya no están disponibles.";
          } else if (error.message) {
            mensajeError = `❌ ${error.message}`;
          }

          mensajeError +=
            "\n\nPuedes intentar nuevamente escribiendo *HOLA* 👋";

          stop(ctx);
          return endFlow(mensajeError);
        }
      } else if (respuesta === "no") {
        stop(ctx);
        return gotoFlow(flowNoPedido);
      } else {
        return fallBack("❌ Por favor responde únicamente con *sí* o *no*.");
      }
    }
  );
// Flujo para generar la factura después del pago confirmado
const flowFactura = addKeyword(["__Factura_Pago_Confirmado__"]).addAnswer(
  "🧾 Generando tu factura digital...",
  null,
  async (ctx, { flowDynamic, state, endFlow }) => {
    try {
      const myState = state.getMyState();

      if (
        !myState.pedidos ||
        myState.pedidos.length === 0 ||
        !myState.ubicacion
      ) {
        stop(ctx);
        return endFlow(
          "❌ Error: Faltan datos del pedido. Por favor inicia nuevamente."
        );
      }

      const nombreUsuario2 =
        ctx?.notification?.name ||
        ctx?.sender?.pushname ||
        ctx?.pushName ||
        "Usuario";

      // Preparar los datos del pedido con TODOS los platillos
      const pedidoData = {
        nombre: nombreUsuario2 || "Usuario",
        telefono: ctx.from,
        latitud: myState.ubicacion.latitud,
        longitud: myState.ubicacion.longitud,
        platillos: myState.pedidos.map((pedido) => ({
          id: pedido.id,
          cantidad: pedido.cantidad,
        })),
      };

      try {
        const pedidoUrl = buildApiUrl("/api/bot-pedido");
        const response = await fetch(pedidoUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(pedidoData),
          timeout: API_TIMEOUT,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.mensaje ||
            `Error HTTP: ${response.status} - ${response.statusText}`
          );
        }

        const data = await response.json();
        console.log(data, "Respuesta del servidor para múltiples pedidos");
      } catch (error) {
        console.error("Error en la solicitud:", error);

        let errorMessage = "❌ Ocurrió un error al procesar tu pedido.";

        if (
          error instanceof TypeError &&
          error.message.includes("Failed to fetch")
        ) {
          errorMessage =
            "❌ No se pudo conectar con el servidor. Intenta nuevamente.";
        } else if (error.message) {
          errorMessage = `❌ ${error.message} o el menú fue modificado, por favor vuelve a escribir *HOLA* para iniciar de nuevo.`;
        }

        stop(ctx);
        return endFlow(errorMessage);
      }

      const nombreUsuario =
        ctx?.notification?.name ||
        ctx?.sender?.pushname ||
        ctx?.pushName ||
        "Usuario";
      const fechaActual = new Date().toLocaleDateString("es-HN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      // FACTURA MEJORADA
      let facturaCompleta = `

 🍽️ **LA CAMPAÑA**        



📅 **Fecha:** ${fechaActual}
👤 **Cliente:** ${nombreUsuario || "Usuario"}
📱 **Teléfono:** ${ctx.from}
🆔 **Referencia:** ${myState.reference || "N/A"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 **DETALLE DE PEDIDO**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

      myState.pedidos.forEach((pedido, index) => {
        const totalPlatillo = pedido.precio_platillo * pedido.cantidad;
        facturaCompleta += `
${index + 1}. **${pedido.nombre_platillo}**
   Cantidad: ${pedido.cantidad} unidades
   Precio unitario: Lps ${pedido.precio_platillo}
   Subtotal: Lps ${totalPlatillo}
`;
      });

      facturaCompleta += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 **RESUMEN DE COSTOS**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🍽️ Subtotal platillos: Lps ${myState.subtotal}
🚚 Costo de envío: ${myState.costoEnvio === 0 ? "GRATIS" : `Lps ${myState.costoEnvio}`
        }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💳 **TOTAL PAGADO: Lps ${myState.totalConEnvio}**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📍 **INFORMACIÓN DE ENTREGA**
📏 Distancia: ${myState.distanciaKm} km
⏱️ Tiempo estimado: ${myState.tiempoMin} minutos

✅ **ESTADO:** Pago confirmado
🚚 **ESTADO DE PEDIDO:** En preparación

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 **¡Gracias por tu compra!**
🏪 La Campaña - Comida de calidad
📞 Soporte: +504 1234-5678
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

      await flowDynamic(facturaCompleta);

      await limpiarEstadoCompleto(state);
      stop(ctx);
    } catch (error) {
      console.error("Error al generar factura:", error);
      stop(ctx);
      return endFlow(
        "❌ Ocurrió un error al procesar tu pedido. Por favor contacta al soporte o vuelve a intentar escribiendo *hola*."
      );
    }
  }
);

const flowNoPedido = addKeyword(["__Pedido__"]).addAnswer(
  "*Parece que no deseas hacer un pedido por el momento.*\n\n" +
  "¡No hay problema! Si alguna vez te antojas de algo delicioso, solo escribe *Hola* 🍽️ y te mostraremos nuestras opciones nuevamente. 😋\n\n" +
  "Gracias por tu tiempo y por estar con nosotros. ¡Esperamos verte pronto!\n\n" +
  "*¡Te deseamos un excelente día!* ✨💫",
  null,
  async (ctx, { state }) => {
    // LIMPIAR ESTADO AL NO HACER PEDIDO
    await limpiarEstadoCompleto(state);
    stop(ctx);
  }
);


const MenuDelDia = addKeyword(["1"])
  .addAction(async (ctx) => {
    // Agregar un identificador único para cada solicitud de menú
    ctx.menuRequestId =
      Date.now() + Math.random().toString(36).substring(2, 10);
    console.log(`[MENU] Nueva solicitud de menú ID: ${ctx.menuRequestId}`);
  })
  .addAnswer(
    null,
    null,
    async (ctx, { flowDynamic, gotoFlow, endFlow, state }) => {
      const requestId = ctx.menuRequestId;
      console.log(`[MENU] Procesando solicitud ${requestId}`);

      // Obtener fecha desde el backend
      const fechaFormateada = await obtenerFechaHoy();
      await flowDynamic(`🗓️ Menú del día:\n ${fechaFormateada}\n`);

      try {




        // VERIFICAR PAGOS PENDIENTES PRIMERO
        const verificacionPago = await verificarPagoPendiente(ctx.from);
        console.log(verificacionPago)
        if (verificacionPago.success) {
          stop(ctx);
          return endFlow(
            "⚠️ *TIENES UN PAGO PENDIENTE*\n\n" +
            "Se está esperando tu pago. No puedes realizar un nuevo pedido hasta completar el pago anterior.\n\n" +
            "👉 Si deseas continuar, por favor realiza el pago desde el link enviado.\n\n" +
            "❌ Si deseas cancelar tu pedido, desde el link de pago selecciona *'No deseo continuar'*."
          );

        }
        // Obtener el menú con el sistema de bloqueo ya incorporado
        const data = await menuAPI();

        if (!data || data.length === 0) {
          stop(ctx);
          return endFlow("😊 No hay menú disponible hoy.");
        }

        // Guardar menú en el estado para uso posterior
        await state.update({ menuData: data });

        // Variable para rastrear si este proceso sigue siendo válido
        let isProcessingCancelled = false;

        // Comprobar periódicamente si hay una solicitud más reciente
        const checkIntervalId = setInterval(() => {
          if (ctx.menuRequestId !== requestId) {
            console.log(
              `[MENU] Solicitud ${requestId} cancelada por una más reciente`
            );
            isProcessingCancelled = true;
            clearInterval(checkIntervalId);
          }
        }, 500);

        // Obtener la imagen única del menú (Paginada de 5 en 5)
        const totalPartes = Math.ceil(data.length / 5);
        console.log(`[MENU] Generando ${totalPartes} partes para ${data.length} platillos`);

        for (let p = 1; p <= totalPartes; p++) {
          // Comprobar si el proceso ha sido cancelado antes de cada parte
          if (isProcessingCancelled) break;

          const menuImagenUrl = buildApiUrl(`/admin/menu/MenuHoyImagen?parte=${p}`);
          const menuImagenFilename = `menu_parte_${p}_${requestId}.png`;

          try {
            const imagePath = await downloadImage(menuImagenUrl, menuImagenFilename);

            if (imagePath) {
              await flowDynamic([
                {
                  body: totalPartes > 1 ? `📋 *Menú de hoy (Parte ${p}/${totalPartes}):*` : "📋 *Aquí tienes nuestro menú de hoy:*",
                  media: imagePath,
                },
              ]);

              // Eliminar imagen para liberar espacio
              if (fs.existsSync(imagePath)) {
                fs.unlink(imagePath, (err) => {
                  if (err) console.error(`[MENU] Error al eliminar ${imagePath}:`, err);
                });
              }
            }
          } catch (error) {
            console.error(`[MENU] Error al procesar parte ${p} en solicitud ${requestId}:`, error);
          }
        }

        // Limpiar intervalo y cache
        clearInterval(checkIntervalId);
        cleanImageCache();

        // Si se canceló el procesamiento, no continuar con la siguiente pregunta
        if (isProcessingCancelled) {
          return endFlow();
        }
      } catch (error) {
        console.error(
          `[MENU] Error general al mostrar menú en solicitud ${requestId}:`,
          error
        );
        stop(ctx);
        return endFlow(
          "❌ Ocurrió un error al mostrar el menú. Por favor escribe *HOLA* para intentar nuevamente."
        );
      }
    }
  )
  .addAnswer(
    "¿Deseas pedir alguno de estos platillos? (responde *sí* o *no*)",
    { capture: true },
    async (ctx, { fallBack, gotoFlow, endFlow, state }) => {
      if (await verificarCancelacion(ctx, state)) {
        stop(ctx);
        return endFlow(
          "❌ *Operación cancelada*\n\nSi deseas hacer un pedido nuevamente, escribe *HOLA* 👋"
        );
      }
      const respuesta = ctx.body
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      if (respuesta === "si" || respuesta === "no") {
        if (respuesta === "si") {
          reset(ctx, gotoFlow, 600000);
          return gotoFlow(flowPedido);
        } else {
          stop(ctx);
          return gotoFlow(flowNoPedido);
        }
      } else {
        return fallBack("❌ Por favor responde únicamente con *sí* o *no*.");
      }
    }
  );

const flowAsesor = addKeyword(["2"])
  .addAnswer(
    "📞 *Contactar con un asesor*\n\n" +
    "Nuestros asesores están disponibles para ayudarte de:\n" +
    "🕘 Lunes a Viernes: 9:00 AM - 6:00 PM\n" +
    "🕘 Sábados: 10:00 AM - 2:00 PM\n\n" +
    "Puedes comunicarte con nosotros a través de:\n" +
    "📱 Teléfono: +504 9622-3676\n" +
    "✉️ Email:  comercial.arsilhn@gmail.com\n\n" +
    "Estaremos encantados de atenderte personalmente." +
    "Si necesitas ayuda inmediata, escribe *HOLA* para volver al menú principal."
  )
  .addAction(async (ctx) => {
    stop(ctx);
  });

const flowRedes = addKeyword(["3"])
  .addAnswer(
    "📢 *Nuestras redes sociales*\n\n" +
    "¡Síguenos para conocer nuestras promociones, novedades y más!\n\n" +
    "📸 Instagram: @lacampfs\n" +
    "👍 Facebook: /La Campaña Food Service\n" +

    "¡Gracias por seguirnos! Escribe *HOLA* cuando quieras volver al menú principal."
  )
  .addAction(async (ctx) => {
    stop(ctx);
  });

const welcomeFlow = addKeyword(EVENTS.WELCOME)
  .addAction(async (ctx, { gotoFlow, state, flowDynamic, endFlow }) => {
    // LIMPIAR ESTADO AL INICIAR NUEVA CONVERSACIÓN
    await limpiarEstadoCompleto(state);

    // VERIFICAR HORARIO ANTES DE CONTINUAR
    const horario = await verificarHorarioActivo();

    if (!horario.esta_activo || !horario.activo) {

      return endFlow();
    }
    start(ctx, gotoFlow, 600000);
  })
  .addAnswer(
    "🍽️ ¡Bienvenido a La Campaña! 🎉 Hola 👋, soy tu asistente virtual y estoy aquí para ayudarte con tu pedido. Para continuar, elige una opción marcando el número correspondiente",
    {
      media: join(process.cwd(), "src", "lacampaña.jpg"),
    }
  )
  .addAnswer(
    [
      "1️⃣ Ver nuestro menú 📋",
      "2️⃣ Hablar con un asesor 📞",
      "3️⃣ Nuestras redes sociales 📢",
      '💡 *Tip:* En cualquier momento puedes escribir *"cancelar"* para terminar la operación.',
    ],
    { capture: true },
    async (ctx, { fallBack, endFlow, state }) => {
      if (await verificarCancelacion(ctx, state)) {
        stop(ctx);
        return endFlow(
          "❌ *Operación cancelada*\n\nSi deseas hacer un pedido nuevamente, escribe *HOLA* 👋"
        );
      }

      if (!["1", "2", "3"].includes(ctx.body.trim())) {
        return fallBack("❌ Opción inválida. Escribe 1, 2 o 3");
      }
    },
    [MenuDelDia, flowRedes, flowAsesor],
    { delay: 1000 }
  );

const pagoProcesadoCorrectamente = addKeyword(
  utils.setEvent("__Pago Procesado__")
).addAction(async (ctx, { flowDynamic, state, endFlow }) => {
  try {
    await flowDynamic("✅ *¡PAGO CONFIRMADO!* 🎉");
    await flowDynamic("🍽️ Preparando tu pedido...");

    const pedidoNumero = pedidosPendientes.get(ctx.from);

    if (pedidoNumero) {
      const { requestId, total, processUrl, pedidoId, telefono, reference } =
        pedidoNumero;

      const resultadoPreparar = await prepararPedido(pedidoId);
      if (resultadoPreparar) {
        await limpiarEstadoCompleto(state);
        pedidosPendientes.delete(ctx.from);
        return endFlow(
          "🎉 *¡PEDIDO CONFIRMADO Y EN PREPARACIÓN!*\n\n" +
          "✅ Tu pago ha sido procesado exitosamente\n" +
          "👨‍🍳 Tu pedido está siendo preparado\n" +
          `📋 Número de pedido: ${pedidoId}\n` +
          `💰 Total pagado: Lps ${total}\n\n` +
          "📞 Te contactaremos pronto para coordinar la entrega\n\n" +
          "¡Gracias por tu compra! 🍽️"
        );
      } else {
        await limpiarEstadoCompleto(state);
        pedidosPendientes.delete(ctx.from);
        return endFlow(
          "⚠️ *Pago confirmado pero hubo un problema*\n\n" +
          "✅ Tu pago fue procesado correctamente\n" +
          "❗ Hubo un error técnico al procesar tu pedido\n\n" +
          "📞 Nos pondremos en contacto contigo para resolver esto\n" +
          `📋 Número de referencia: ${pedidoId}\n\n` +
          "Disculpa las molestias"
        );
      }
    }
  } catch (error) {
    console.error("Error en pago procesado correctamente:", error);
    stop(ctx);
    return endFlow(
      "❌ Ocurrió un error al procesar tu pago. Por favor contacta al soporte o vuelve a intentar escribiendo *hola*."
    );
  }
});

const pagoProcesadoIncorrectamente = addKeyword(
  utils.setEvent("__Pago Incorrectamente__")
).addAction(async (ctx, { flowDynamic, state, endFlow }) => {
  try {
    const pedidoNumero = pedidosPendientes.get(ctx.from);

    if (pedidoNumero) {
      const { requestId, processUrl, pedidoId, telefono, reference } =
        pedidoNumero;

      await cancelarPedido(pedidoId);
      pedidosPendientes.delete(ctx.from);
      return endFlow(
        "⏰ *TIEMPO DE VERIFICACIÓN AGOTADO*\n\n" +
        "No pudimos confirmar tu pago en los últimos 5 minutos.\n" +
        "El pedido ha sido cancelado automáticamente.\n\n" +
        "💡 *¿Qué hacer?*\n" +
        "• Si completaste el pago, contacta a soporte\n" +
        "• Si no pagaste, puedes intentar nuevamente escribiendo *HOLA*\n\n" +
        `📋 Referencia: ${reference || "N/A"}\n` +
        `📋 Número de pedido cancelado: ${pedidoId}`
      );
    }
  } catch (error) {
    console.error("Error en pago procesado incorrectamente:", error);
    stop(ctx);
    return endFlow(
      "❌ Ocurrió un error al procesar tu pago. Por favor contacta al soporte o vuelve a intentar escribiendo *hola*."
    );
  }
});

const main = async () => {
  const adapterFlow = createFlow([
    welcomeFlow,
    flowPedido,
    flowNoPedido,
    flowNotas,
    idleFlow,
    flowFactura,
    pagoProcesadoCorrectamente,
    pagoProcesadoIncorrectamente,
  ]);

  const adapterProvider = createProvider(Provider, {
    puppeteerOptions: {
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
      timeout: 120000, // Aumentar timeout para evitar problemas de conexión
    },
  });

  // const adapterDB = new Database({
  //   host: process.env.DB_HOST || "127.0.0.1",
  //   user: process.env.DB_USER || "root",
  //   database: process.env.DB_NAME || "bot",
  //   password: process.env.DB_PASSWORD || "",
  //   connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
  // });
  const adapterDB = new Database({ filename: 'db.json' })
  const { handleCtx, httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  });

  adapterProvider.server.post(
    "/v1/process-payment",
    handleCtx(async (bot, req, res) => {
      const { requestId, reference, number, status, name, pedido_id } = req.body;

      if (!requestId || !reference || !number || !status || !name) {
        return res.end("Missing required fields");
      }


      try {
        if (status !== "approved") {
          console.log("llegamos al !aprovved")
          //await bot.dispatch("__Pago Incorrectamente__", { from: number, name });
          await cancelarPedido(pedido_id);
          const message = "⏰ * PAGO RECHAZADO*\n\n" +
            "No pudimos confirmar tu pago en los últimos 5 minutos.\n" +
            "El pedido ha sido cancelado automáticamente.\n\n" +
            "💡 *¿Qué hacer?*\n" +
            "• Si completaste el pago, contacta a soporte\n" +
            "• Si no pagaste, puedes intentar nuevamente escribiendo *HOLA*\n\n" +
            `📋 Referencia: ${reference || "N/A"}\n` +
            `📋 Número de pedido cancelado: ${pedido_id}`
          await bot.sendMessage(number, message, { media: null })
          return res.end("Payment not approved");
        } else {
          console.log("llegamos al aprovved")
          // await bot.dispatch("__Pago Procesado__", { from: number, name });
          await bot.sendMessage(number, "✅ *¡PAGO CONFIRMADO!* 🎉", { media: null })

          await bot.sendMessage(number, "🍽️ Preparando tu pedido...", { media: null })
          await prepararPedido(pedido_id)
          const pagoProcesadoMessage = "🎉 *¡PEDIDO CONFIRMADO Y EN PREPARACIÓN!*\n\n" +
            "✅ Tu pago ha sido procesado exitosamente\n" +
            "👨‍🍳 Tu pedido está siendo preparado\n" +
            `📋 Número de pedido: ${pedido_id}\n` +
            "📞 Te contactaremos pronto para coordinar la entrega\n\n" +
            "¡Gracias por tu compra! 🍽️"
          await bot.sendMessage(number, pagoProcesadoMessage, { media: null })


          return res.end("Payment approved");
        }
      } catch (error) {
        console.log(error)
      }
    })
  );
  adapterProvider.server.post(
    "/v1/send-message",
    handleCtx(async (bot, req, res) => {
      try {
        const { numero, mensaje } = req.body;

        // Validar campos obligatorios
        if (!numero || !mensaje) {
          return res.end(JSON.stringify({
            success: false,
            error: "Faltan campos requeridos: numero y mensaje"
          }));
        }

        // Formatear el número (agregar @c.us)
        const numeroFormateado = numero.replace(/\D/g, '') + '@c.us';

        console.log(`📤 Enviando mensaje a: ${numeroFormateado}`);
        console.log(`💬 Mensaje: ${mensaje}`);

        // Enviar el mensaje
        await bot.sendMessage(numeroFormateado, mensaje, { media: null });

        // Respuesta exitosa
        return res.end(JSON.stringify({
          success: true,
          message: "Mensaje enviado exitosamente",
          data: {
            destinatario: numeroFormateado,
            mensaje: mensaje
          }
        }));

      } catch (error) {
        console.error("❌ Error enviando mensaje:", error);

        return res.end(JSON.stringify({
          success: false,
          error: "Error al enviar el mensaje",
          detalles: error.message
        }));
      }
    })
  );
  adapterProvider.server.post(
    "/v1/messages",
    handleCtx(async (bot, req, res) => {
      const { number, message, urlMedia } = req.body;
      await bot.sendMessage(number, message, { media: urlMedia ?? null });
      return res.end("sended");
    })
  );

  adapterProvider.server.post(
    "/v1/register",
    handleCtx(async (bot, req, res) => {
      const { number, name } = req.body;
      await bot.dispatch("REGISTER_FLOW", { from: number, name });
      return res.end("trigger");
    })
  );

  adapterProvider.server.post(
    "/v1/samples",
    handleCtx(async (bot, req, res) => {
      const { number, name } = req.body;
      await bot.dispatch("SAMPLES", { from: number, name });
      return res.end("trigger");
    })
  );

  adapterProvider.server.post(
    "/v1/blacklist",
    handleCtx(async (bot, req, res) => {
      const { number, intent } = req.body;
      if (intent === "remove") bot.blacklist.remove(number);
      if (intent === "add") bot.blacklist.add(number);

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", number, intent }));
    })
  );

  process.on("SIGINT", async () => {
    console.log("Cerrando bot...");
    await adapterProvider.vendor?.ws?.close(); // cerrar socket si existe
    process.exit(0);
  });

  httpServer(+PORT);
};

main();
