const deepl = require("deepl-node");
const fs = require("fs").promises;
const path = require("path");
const config = require("./config.json");

/**
 * Задержка в миллисекундах
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Переводит текст с повторными попытками при ошибке "Too many requests"
 */
async function translateWithRetry(translator, text, sourceLang, targetLang, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await translator.translateText(text, sourceLang, targetLang);
      return result;
    } catch (error) {
      const errorMessage = error.message || String(error);
      
      // Проверяем, является ли это ошибкой "Too many requests"
      if (errorMessage.includes("Too many requests") || errorMessage.includes("high load")) {
        if (attempt < maxRetries) {
          // Экспоненциальная задержка: 2^attempt секунд
          const delay = Math.min(1000 * Math.pow(2, attempt), 60000); // Максимум 60 секунд
          console.log(
            `  ⚠ Too many requests, попытка ${attempt}/${maxRetries}, ожидание ${delay / 1000}с...`
          );
          await sleep(delay);
          continue;
        } else {
          throw new Error(`Превышено количество попыток. Последняя ошибка: ${errorMessage}`);
        }
      }
      
      // Для других ошибок сразу выбрасываем исключение
      throw error;
    }
  }
}

/**
 * Главная функция перевода
 */
async function main() {
  const inputFile = "data.json";
  const outputFile = "dataRu.json";

  // Проверяем наличие API ключа

  const authKey = config["DEEPL_AUTH_KEY"];
  if (!authKey) {
    console.error(
      "❌ Ошибка: Не найден API ключ DeepL. Установите переменную окружения DEEPL_AUTH_KEY"
    );
    console.error(
      "Пример: export DEEPL_AUTH_KEY=your-api-key-here"
    );
    process.exit(1);
  }

  // Инициализируем клиент DeepL
  const translator = new deepl.Translator(authKey);

  console.log("Загрузка данных из data.json...");
  let data;
  try {
    const fileContent = await fs.readFile(inputFile, "utf-8");
    data = JSON.parse(fileContent);
  } catch (error) {
    console.error(`❌ Ошибка при чтении ${inputFile}:`, error.message);
    process.exit(1);
  }

  if (!Array.isArray(data) || data.length === 0) {
    console.error("❌ Файл data.json пуст или содержит некорректные данные");
    process.exit(1);
  }

  console.log(`Найдено записей для перевода: ${data.length}`);

  // Загружаем существующие переводы, если файл существует
  let existingTranslations = [];
  try {
    const existingContent = await fs.readFile(outputFile, "utf-8");
    existingTranslations = JSON.parse(existingContent);
    console.log(
      `Загружено существующих переводов: ${existingTranslations.length}`
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`⚠ Ошибка при чтении ${outputFile}:`, error.message);
    }
  }

  // Создаем Map существующих переводов по URL для быстрого поиска
  const existingMap = new Map();
  // Создаем Set существующих переведенных вопросов для проверки дублей
  const existingQuestions = new Set();
  existingTranslations.forEach((item) => {
    if (item.url) {
      existingMap.set(item.url, item);
    }
    if (item.question) {
      existingQuestions.add(item.question.toLowerCase().trim());
    }
  });

  const results = [];
  let translatedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    const progress = `[${i + 1}/${data.length}]`;

    // Проверяем, есть ли уже перевод для этого URL
    if (existingMap.has(item.url)) {
      console.log(`${progress} ⏭ Пропущен (уже переведен по URL): ${item.url}`);
      results.push(existingMap.get(item.url));
      skippedCount++;
      continue;
    }

    try {
      console.log(`\n${progress} Перевод: ${item.question_en}`);
      console.log(`URL: ${item.url}`);

      // Переводим вопрос с повторными попытками
      const questionTranslation = await translateWithRetry(
        translator,
        item.question_en,
        "en",
        "ru"
      );
      const questionRu = questionTranslation.text;

      // Проверяем, есть ли уже такой переведенный вопрос
      const questionKey = questionRu.toLowerCase().trim();
      if (existingQuestions.has(questionKey)) {
        console.log(`${progress} ⏭ Пропущен (дубль по переведенному вопросу): "${questionRu}"`);
        skippedCount++;
        continue;
      }

      console.log(`  Вопрос (EN): ${item.question_en}`);
      console.log(`  Вопрос (RU): ${questionRu}`);

      // Переводим варианты ответов
      const variantsRu = [];
      for (let j = 0; j < item.variants_en.length; j++) {
        const variant = item.variants_en[j];
        const variantTranslation = await translateWithRetry(
          translator,
          variant.variant,
          "en",
          "ru"
        );
        const variantRu = variantTranslation.text;

        variantsRu.push({
          variant: variantRu,
          points: variant.points,
        });

        console.log(
          `  Вариант ${j + 1}: "${variant.variant}" → "${variantRu}" (${variant.points} очков)`
        );

        // Увеличиваем задержку между запросами, чтобы не превысить лимиты API
        await sleep(500);
      }

      // Формируем результат
      const translatedItem = {
        url: item.url,
        question_en: item.question_en,
        question: questionRu,
        variants: variantsRu,
      };

      results.push(translatedItem);
      // Добавляем переведенный вопрос в Set для проверки дублей
      existingQuestions.add(questionKey);
      translatedCount++;

      // Сохраняем промежуточные результаты после каждого перевода
      await fs.writeFile(
        outputFile,
        JSON.stringify(results, null, 2),
        "utf-8"
      );
      console.log(`  ✓ Сохранено в ${outputFile}`);

      // Увеличиваем задержку между записями
      await sleep(1000);
    } catch (error) {
      console.error(`\n❌ Ошибка при переводе записи ${i + 1}:`, error.message);
      console.error(`URL: ${item.url}`);
      // Продолжаем обработку следующих записей
      continue;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Перевод завершен!`);
  console.log(`Переведено новых записей: ${translatedCount}`);
  console.log(`Пропущено (уже переведено): ${skippedCount}`);
  console.log(`Всего записей в файле: ${results.length}`);
  console.log(`Данные сохранены в ${outputFile}`);
  console.log("=".repeat(60));
}

// Запуск программы
if (require.main === module) {
  main().catch((error) => {
    console.error("Критическая ошибка:", error);
    process.exit(1);
  });
}

module.exports = { main };

