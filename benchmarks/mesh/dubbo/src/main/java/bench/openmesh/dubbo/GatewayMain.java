package bench.openmesh.dubbo;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.apache.dubbo.common.constants.CommonConstants;
import org.apache.dubbo.config.ApplicationConfig;
import org.apache.dubbo.config.ReferenceConfig;
import org.apache.dubbo.config.RegistryConfig;
import org.apache.dubbo.config.bootstrap.DubboBootstrap;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;

public final class GatewayMain {
    private static String awaitReady(BenchService service, String label) throws Exception {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(30);
        Throwable last = null;
        while (System.nanoTime() < deadline) {
            try {
                return service.work();
            } catch (Throwable error) {
                last = error;
                Thread.sleep(250);
            }
        }
        throw new IllegalStateException(label + " did not become ready within 30s", last);
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) {
            output.write(bytes);
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) {
            throw new IllegalArgumentException("Usage: GatewayMain <direct-provider-port> <zookeeper-host:port> <http-port>");
        }

        int directPort = Integer.parseInt(args[0]);
        String zookeeper = args[1];
        int httpPort = Integer.parseInt(args[2]);

        System.setProperty("dubbo.application.service-discovery.migration", "FORCE_INTERFACE");

        ApplicationConfig application = new ApplicationConfig("openmesh-bench-gateway");
        application.setQosEnable(false);

        RegistryConfig registry = new RegistryConfig("zookeeper://" + zookeeper);
        registry.setRegisterMode("interface");

        ReferenceConfig<BenchService> directReference = new ReferenceConfig<>();
        directReference.setInterface(BenchService.class);
        directReference.setProtocol(CommonConstants.TRIPLE);
        directReference.setUrl("tri://127.0.0.1:" + directPort);
        directReference.setTimeout(3000);
        directReference.setRetries(0);
        directReference.setCheck(true);

        ReferenceConfig<BenchService> meshReference = new ReferenceConfig<>();
        meshReference.setInterface(BenchService.class);
        meshReference.setProtocol(CommonConstants.TRIPLE);
        meshReference.setTimeout(3000);
        meshReference.setRetries(0);
        meshReference.setCheck(false);
        meshReference.setLoadbalance("p2c");

        DubboBootstrap bootstrap = DubboBootstrap.getInstance();
        bootstrap
            .application(application)
            .registry(registry)
            .reference(directReference)
            .reference(meshReference)
            .start();

        BenchService direct = directReference.get();
        BenchService mesh = meshReference.get();

        // Registration and consumer discovery are asynchronous. Only expose
        // the benchmark gateway after both references can complete real calls.
        awaitReady(direct, "direct Dubbo reference");
        awaitReady(mesh, "registry-backed Dubbo reference");

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", httpPort), 256);
        server.setExecutor(Executors.newFixedThreadPool(Math.max(32, Runtime.getRuntime().availableProcessors() * 16)));

        server.createContext("/health", exchange -> {
            if (!"GET".equals(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(405, -1);
                exchange.close();
                return;
            }
            respond(exchange, 200, "{\"ok\":true}");
        });

        server.createContext("/direct", exchange -> {
            try {
                respond(exchange, 200, direct.work());
            } catch (Throwable error) {
                respond(exchange, 502, "{\"error\":\"direct dubbo invocation failed\"}");
            }
        });

        server.createContext("/mesh", exchange -> {
            try {
                respond(exchange, 200, mesh.work());
            } catch (Throwable error) {
                respond(exchange, 502, "{\"error\":\"mesh dubbo invocation failed\"}");
            }
        });

        server.start();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop(0);
            bootstrap.stop();
        }));

        System.out.println("READY " + server.getAddress().getPort());
        System.out.flush();

        Thread.currentThread().join();
    }
}
