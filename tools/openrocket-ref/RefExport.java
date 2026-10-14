import java.io.File;
import java.io.PrintWriter;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import com.google.inject.AbstractModule;
import com.google.inject.Guice;
import com.google.inject.Module;

import info.openrocket.core.database.ComponentPresetDao;
import info.openrocket.core.database.ComponentPresetDatabase;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.file.wavefrontobj.ObjUtils;
import info.openrocket.core.file.wavefrontobj.export.OBJExportOptions;
import info.openrocket.core.file.wavefrontobj.export.OBJExporterFactory;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.plugin.PluginModule;
import info.openrocket.core.rocketcomponent.ComponentAssembly;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.startup.Application;
import info.openrocket.core.startup.CoreModule;
import info.openrocket.core.util.Coordinate;

/**
 * Headless reference export, run with OpenRocket's own Java runtime and jar. For one .ork it writes:
 *
 *   <out>.obj   OpenRocket's own OBJ export: every component in its real position, all instances
 *               (every fin, every rail button), not triangulated, highest detail, in millimetres.
 *               Axes are OpenRocket's default OBJ transform: z = rocket axis, tail at z = 0 and the
 *               tip at z = rocket length; x = OpenRocket's y; y = OpenRocket's z.
 *   <out>.json  What OpenRocket computes for each component: position of every instance, length,
 *               mass and volume, plus its comment. Units are SI (metres, kilograms), as inside
 *               OpenRocket.
 *
 * Usage: java -cp OpenRocket-24.12.jar;build RefExport <in.ork> <out-base-path>
 * Compile: see scripts/make-reference.ts.
 */
public class RefExport {
	public static void main(String[] args) throws Exception {
		if (args.length < 2) {
			System.err.println("usage: RefExport <in.ork> <out-base-path>");
			System.exit(2);
		}
		File in = new File(args[0]);
		String outBase = args[1];

		// The component-preset and motor databases aren't needed for geometry, so skip loading them.
		System.setProperty("openrocket.bypass.presets", "true");
		System.setProperty("openrocket.bypass.motors", "true");

		// Headless start-up as documented in OpenRocket's CoreModule. Its preferences live in a separate
		// "OpenRocket-core" node, so the OpenRocket app's own settings are untouched. CoreModule doesn't
		// bind the preset lookup interface, which designs using parts-database presets need while loading.
		CoreModule core = new CoreModule();
		Module presetLookup = new AbstractModule() {
			@Override
			protected void configure() {
				bind(ComponentPresetDao.class).to(ComponentPresetDatabase.class);
			}
		};
		Application.setInjector(Guice.createInjector(core, presetLookup, new PluginModule()));
		core.startLoader();

		OpenRocketDocument doc = new GeneralRocketLoader(in).load();
		Rocket rocket = doc.getRocket();

		List<RocketComponent> components = new ArrayList<>();
		components.add(rocket);

		OBJExportOptions options = new OBJExportOptions(rocket);
		options.setExportChildren(true);
		options.setExportAllInstances(true);
		options.setExportMotors(false);
		options.setExportAppearance(false);
		options.setExportAsSeparateFiles(false);
		options.setRemoveOffset(false);
		options.setTriangulate(false);
		options.setLOD(ObjUtils.LevelOfDetail.HIGH_QUALITY);
		options.setScaling(1000f);

		WarningSet warnings = new WarningSet();
		new OBJExporterFactory(components, rocket.getSelectedConfiguration(), new File(outBase + ".obj"), options,
				warnings).doExport();

		try (PrintWriter w = new PrintWriter(new File(outBase + ".json"), StandardCharsets.UTF_8)) {
			w.println("{");
			w.println("  \"openrocketVersion\": \"24.12\",");
			w.println("  \"rocket\": " + str(rocket.getName()) + ",");
			w.println("  \"rocketLength\": " + num(rocket.getLength()) + ",");
			w.println("  \"components\": [");
			List<RocketComponent> all = rocket.getAllChildren();
			int objGroup = 1; // same numbering the OBJ exporter uses for its group names
			for (int i = 0; i < all.size(); i++) {
				RocketComponent c = all.get(i);
				boolean assembly = c instanceof ComponentAssembly;
				StringBuilder s = new StringBuilder("    {");
				s.append("\"name\": ").append(str(c.getName()));
				s.append(", \"type\": ").append(str(c.getClass().getSimpleName()));
				s.append(", \"id\": ").append(str(c.getID().toString()));
				s.append(", \"comment\": ").append(str(c.getComment()));
				s.append(", \"objGroup\": ").append(assembly ? "null" : str(objGroup + "_" + c.getName()));
				s.append(", \"length\": ").append(num(c.getLength()));
				s.append(", \"instanceCount\": ").append(c.getInstanceCount());
				s.append(", \"locations\": [");
				Coordinate[] locs = c.getComponentLocations();
				for (int k = 0; k < locs.length; k++) {
					if (k > 0) s.append(", ");
					s.append("[").append(num(locs[k].x)).append(", ").append(num(locs[k].y)).append(", ")
							.append(num(locs[k].z)).append("]");
				}
				s.append("]");
				s.append(", \"componentMass\": ").append(num(c.getComponentMass()));
				Object volume = call(c, "getComponentVolume");
				s.append(", \"componentVolume\": ").append(volume instanceof Double ? num((Double) volume) : "null");
				Object material = call(c, "getMaterial");
				if (material != null) {
					s.append(", \"materialDensity\": ").append(num((Double) call(material, "getDensity")));
					s.append(", \"materialType\": ").append(str(String.valueOf(call(material, "getType"))));
				}
				s.append("}");
				if (i < all.size() - 1) s.append(",");
				w.println(s);
				if (!assembly) objGroup++;
			}
			w.println("  ],");
			w.println("  \"warnings\": " + str(warnings.toString()));
			w.println("}");
		}

		System.out.printf(Locale.ROOT, "%s: rocket length %.3f mm, wrote %s.obj and .json%n", rocket.getName(),
				rocket.getLength() * 1000, outBase);
		if (!warnings.isEmpty()) {
			System.out.println("OpenRocket warnings: " + warnings);
		}
		System.exit(0);
	}

	private static Object call(Object target, String method) {
		try {
			Method m = target.getClass().getMethod(method);
			return m.invoke(target);
		} catch (ReflectiveOperationException e) {
			return null;
		}
	}

	private static String num(double v) {
		if (Double.isNaN(v) || Double.isInfinite(v)) return "null";
		return Double.toString(v);
	}

	private static String str(String v) {
		StringBuilder s = new StringBuilder("\"");
		for (char ch : v.toCharArray()) {
			switch (ch) {
				case '"' -> s.append("\\\"");
				case '\\' -> s.append("\\\\");
				case '\n' -> s.append("\\n");
				case '\r' -> s.append("\\r");
				case '\t' -> s.append("\\t");
				default -> {
					if (ch < 0x20) s.append(String.format("\\u%04x", (int) ch));
					else s.append(ch);
				}
			}
		}
		return s.append("\"").toString();
	}
}
