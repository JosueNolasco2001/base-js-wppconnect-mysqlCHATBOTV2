// idle-custom.js
import { EVENTS, addKeyword } from '@builderbot/bot';

// Objeto para guardar los temporizadores por usuario
const timers = {};

// Flujo que se ejecuta si el usuario no responde a tiempo
const idleFlow = addKeyword(EVENTS.ACTION).addAction(async (_, { endFlow }) => {
    return endFlow("⏰ El tiempo de respuesta ha expirado. Si deseas continuar, vuelve a escribir.");
});

// Inicia el temporizador de inactividad para un usuario
const start = (ctx, gotoFlow, ms) => {
    timers[ctx.from] = setTimeout(() => {
        console.log(`⏱ Usuario inactivo: ${ctx.from}`);
        return gotoFlow(idleFlow);
    }, ms);
};

// Reinicia el temporizador de inactividad si el usuario sigue activo
const reset = (ctx, gotoFlow, ms) => {
    stop(ctx);
    if (timers[ctx.from]) {
        console.log(`🔄 Reiniciando temporizador para: ${ctx.from}`);
        clearTimeout(timers[ctx.from]);
    }
    start(ctx, gotoFlow, ms);
};

// Detiene el temporizador del usuario
const stop = (ctx) => {
    if (timers[ctx.from]) {
        clearTimeout(timers[ctx.from]);
    }
};

export { 
    start,
    reset, 
    stop,
    idleFlow 
};