package bench.openmesh.dubbo;

import org.apache.dubbo.common.constants.CommonConstants;
import org.apache.dubbo.config.ApplicationConfig;
import org.apache.dubbo.config.ProtocolConfig;
import org.apache.dubbo.config.RegistryConfig;
import org.apache.dubbo.config.ServiceConfig;
import org.apache.dubbo.config.bootstrap.DubboBootstrap;

public final class ProviderMain {
    public static void main(String[] args) {
        if (args.length != 3) {
            throw new IllegalArgumentException("Usage: ProviderMain <instance> <port> <zookeeper-host:port>");
        }

        String instance = args[0];
        int port = Integer.parseInt(args[1]);
        String zookeeper = args[2];

        ApplicationConfig application = new ApplicationConfig("openmesh-bench-provider");
        application.setQosEnable(false);
        application.setRegisterMode("interface");

        RegistryConfig registry = new RegistryConfig("zookeeper://" + zookeeper);
        registry.setRegisterMode("interface");

        ProtocolConfig protocol = new ProtocolConfig(CommonConstants.TRIPLE, port);

        ServiceConfig<BenchService> service = new ServiceConfig<>();
        service.setInterface(BenchService.class);
        service.setRef(() -> "{\"ok\":true,\"instance\":\"" + instance + "\"}");

        DubboBootstrap bootstrap = DubboBootstrap.getInstance();
        bootstrap
            .application(application)
            .registry(registry)
            .protocol(protocol)
            .service(service)
            .start();

        Runtime.getRuntime().addShutdownHook(new Thread(bootstrap::stop));
        System.out.println("READY " + instance + " " + port);
        System.out.flush();
        bootstrap.await();
    }
}
