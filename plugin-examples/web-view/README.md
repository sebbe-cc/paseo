# Web view example

Renders one HTML page inside a plugin surface and exchanges messages with it. The page reports its
button clicks to the plugin, and the plugin sends the page the active theme's colors.

```sh
paseo plugin install /absolute/path/to/paseo/plugin-examples/web-view
```

Open **Web view example** from the sidebar. The status line reads "The page is ready." once the page
has loaded, and the click count follows the button inside the page. Switching the Paseo theme
recolors the page.

It needs a host with the SDK `WebView`. See the
[web content reference](https://paseo.sh/docs/plugins/reference#web-content) for the contract and
what the frame refuses.
