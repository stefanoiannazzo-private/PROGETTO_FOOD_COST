# Ambiente locale (Windows/macOS/Linux con Docker Desktop) che riproduce l'hosting condiviso:
# Apache + mod_rewrite + .htaccess, PHP 8.3 (mod_php), radice web = cartella del progetto come su Aruba.
FROM php:8.3-apache

RUN apt-get update \
 && apt-get install -y --no-install-recommends libzip-dev libicu-dev unzip git default-mysql-client \
 && docker-php-ext-install pdo_mysql zip intl opcache \
 && a2enmod rewrite headers \
 && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# .htaccess abilitati ovunque (come sull'hosting) e radice web sulla cartella del progetto
RUN sed -ri 's!AllowOverride None!AllowOverride All!g' /etc/apache2/apache2.conf \
 && printf 'ServerName localhost\n' > /etc/apache2/conf-available/servername.conf && a2enconf servername

COPY docker/php/php.ini /usr/local/etc/php/conf.d/foodcost.ini
COPY docker/php/entrypoint.sh /usr/local/bin/foodcost-entrypoint
RUN chmod +x /usr/local/bin/foodcost-entrypoint

WORKDIR /var/www/html
ENTRYPOINT ["foodcost-entrypoint"]
CMD ["apache2-foreground"]
