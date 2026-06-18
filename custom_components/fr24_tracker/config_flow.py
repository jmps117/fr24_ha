import aiohttp
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
import voluptuous as vol

from .const import (
    CONF_HOST,
    CONF_LOW_ALT_RADIUS,
    CONF_LOW_ALT_THRESHOLD,
    CONF_PORT,
    CONF_SCAN_INTERVAL,
    CONF_WATCH_LIST,
    DEFAULT_HOST,
    DEFAULT_LOW_ALT_RADIUS,
    DEFAULT_LOW_ALT_THRESHOLD,
    DEFAULT_PORT,
    DEFAULT_SCAN_INTERVAL,
    DEFAULT_WATCH_LIST,
    DOMAIN,
)


class FR24ConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: config_entries.ConfigEntry) -> "FR24OptionsFlow":
        return FR24OptionsFlow()

    async def async_step_user(self, user_input=None):
        errors = {}

        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            port = user_input[CONF_PORT]
            try:
                session = async_get_clientsession(self.hass)
                async with session.get(
                    f"http://{host}:{port}/flights.json",
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    resp.raise_for_status()
                    await resp.json(content_type=None)
            except Exception:
                errors["base"] = "cannot_connect"
            else:
                await self.async_set_unique_id(f"{host}:{port}")
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=f"FR24 Feeder ({host})",
                    data={**user_input, CONF_HOST: host},
                )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_HOST, default=DEFAULT_HOST): str,
                    vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
                    vol.Required(CONF_SCAN_INTERVAL, default=DEFAULT_SCAN_INTERVAL): int,
                }
            ),
            errors=errors,
        )


class FR24OptionsFlow(config_entries.OptionsFlow):
    async def async_step_init(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(data=user_input)

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_LOW_ALT_THRESHOLD,
                        default=self.config_entry.options.get(
                            CONF_LOW_ALT_THRESHOLD, DEFAULT_LOW_ALT_THRESHOLD
                        ),
                    ): int,
                    vol.Required(
                        CONF_LOW_ALT_RADIUS,
                        default=self.config_entry.options.get(
                            CONF_LOW_ALT_RADIUS, DEFAULT_LOW_ALT_RADIUS
                        ),
                    ): int,
                    vol.Optional(
                        CONF_WATCH_LIST,
                        default=self.config_entry.options.get(CONF_WATCH_LIST, DEFAULT_WATCH_LIST),
                    ): str,
                }
            ),
        )
