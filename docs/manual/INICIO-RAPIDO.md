# 🚀 INICIO RÁPIDO - Cartera Dashboard

## Iniciar la aplicación (RECOMENDADO - Navegador Web)

```powershell
cd C:\Proyectos\Zenith-Cartera
pnpm start
```

Luego abre tu navegador en: **http://localhost:5173**

**Credenciales de demostración:**
- Usuario: `demo`
- Contraseña: `demo123`

---

## ✅ Lo que está funcionando

- ✅ Servidor Vite en desarrollo
- ✅ API local conectada (http://192.168.56.1:3000)
- ✅ Base de datos SQLite
- ✅ Hot Module Reload (cambios en vivo)
- ✅ **Optimizaciones aplicadas:**
  - Lazy loading de Excel/PDF (solo cargan cuando se usan)
  - useMemo en filtros (caché inteligente)
  - CSS optimizado con clases reutilizables

---

## 📦 Instalación inicial

Si es la primera vez que ejecutas el proyecto:

```powershell
pnpm install
pnpm exec electron-rebuild
```

---

## 🛠️ Comandos disponibles

| Comando | Descripción |
|---------|-------------|
| `pnpm start` | Inicia solo el servidor web (RECOMENDADO) |
| `pnpm dev` | Inicia Vite + Electron (experimental) |
| `pnpm dev:renderer` | Solo servidor Vite |
| `pnpm build` | Compila para producción |
| `pnpm build:installer` | Crea instalador Windows |

---

## 🔧 Si algo no funciona

1. **Detener todos los procesos:**
```powershell
Get-Process node, electron -ErrorAction SilentlyContinue | Stop-Process -Force
```

2. **Reiniciar:**
```powershell
pnpm start
```

3. **Limpiar caché:**
```powershell
Remove-Item node_modules -Recurse -Force
Remove-Item .vite -Recurse -Force -ErrorAction SilentlyContinue
pnpm install
```

---

## 📊 Estructura del proyecto

```
cartera-dashboard/
├── src/              # Código React (frontend)
│   ├── App.tsx       # Componente principal (2,994 líneas)
│   ├── App.css       # Estilos (3,191 líneas + utilidades)
│   └── utils/        # Funciones de formateo
├── electron/         # Proceso principal Electron
│   ├── main.ts       # Ventana principal
│   ├── db.ts         # Base de datos SQLite
│   └── preload.ts    # Bridge seguro
├── dist/             # Build del frontend
├── dist-electron/    # Build de Electron
└── public/           # Assets estáticos
```

---

## 🎯 Próximos pasos opcionales

- [ ] Arreglar Electron para versión de escritorio
- [ ] Optimizar bundle size (chunks >500KB)
- [ ] Migrar estilos inline restantes a CSS
- [ ] Configurar CI/CD para builds automáticos

---

**Última actualización:** 1 de febrero de 2026  
**Estado:** ✅ Funcional en navegador | ⚠️ Electron en desarrollo
